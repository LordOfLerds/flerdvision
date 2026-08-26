import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { JsonWorkspaceRegistry } from "../dist/adapters/workspace/json-registry.js";
import { WorkspaceService, workspaceRuntimeLayout } from "../dist/application/workspaces.js";
import { ReleaseQualificationService } from "../dist/application/release-qualification.js";
import { SqliteControlPlaneStore } from "../dist/adapters/storage/sqlite.js";
import { SelfServiceHttpServer } from "../dist/adapters/setup/self-service-http.js";

function tempRoot() { return mkdtempSync(join(tmpdir(), "flerdvision-w8a-")); }
function registry(root) { return new JsonWorkspaceRegistry(join(root, "registry", "workspaces.json")); }

const actor = { type: "test", id: "w8a" };

test("workspace runtime is physically isolated and private", () => {
  const root = tempRoot();
  try {
    const reg = registry(root); const service = new WorkspaceService(reg, root);
    const luca = service.create({ workspaceId: "luca", displayName: "Luca", now: "2026-08-26T20:00:00Z" });
    const fabian = service.create({ workspaceId: "fabian", displayName: "Fabian", now: "2026-08-26T20:01:00Z" });
    assert.notEqual(luca.layout.databasePath, fabian.layout.databasePath);
    assert.notEqual(luca.layout.profilesDir, fabian.layout.profilesDir);
    for (const path of [luca.layout.workspaceRoot, luca.layout.profilesDir, luca.layout.evidenceDir, fabian.layout.workspaceRoot]) {
      assert.equal(statSync(path).mode & 0o077, 0, `${path} must be private`);
    }
    assert.throws(() => workspaceRuntimeLayout(root, "../escape"), /Unsafe workspace id/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("same account ids can exist independently in Luca and Fabian workspace databases", () => {
  const root = tempRoot();
  try {
    const reg = registry(root); const service = new WorkspaceService(reg, root);
    const a = service.create({ workspaceId: "luca", displayName: "Luca", now: "2026-08-26T20:00:00Z" });
    const b = service.create({ workspaceId: "fabian", displayName: "Fabian", now: "2026-08-26T20:01:00Z" });
    const sa = new SqliteControlPlaneStore(a.layout.databasePath); const sb = new SqliteControlPlaneStore(b.layout.databasePath);
    try {
      sa.registerSocialAccount({ accountId: "instagram_primary", platform: "instagram", expectedHandle: "luca_test", enabled: true }, "2026-08-26T20:02:00Z", actor);
      sb.registerSocialAccount({ accountId: "instagram_primary", platform: "instagram", expectedHandle: "fabian_test", enabled: true }, "2026-08-26T20:03:00Z", actor);
      assert.equal(sa.getSocialAccount("instagram_primary").account.expectedHandle, "luca_test");
      assert.equal(sb.getSocialAccount("instagram_primary").account.expectedHandle, "fabian_test");
    } finally { sa.close(); sb.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("release promotion enforces Luca Mac -> Fabian Mac -> VPS staging -> production-ready order", () => {
  const root = tempRoot();
  try {
    const reg = registry(root); const q = new ReleaseQualificationService(reg); const sha = "abc123";
    assert.throws(() => q.start({ releaseSha: sha, stage: "FABIAN_MAC", workspaceId: "fabian", hostFingerprint: "fabian-mac", now: "2026-08-26T20:00:00Z", operatorId: "tester" }), /predecessor stage LUCA_MAC/);
    const luca = q.start({ runId: "run:luca", releaseSha: sha, stage: "LUCA_MAC", workspaceId: "luca", hostFingerprint: "luca-mac", now: "2026-08-26T20:01:00Z", operatorId: "tester" });
    for (const gate of ["INSTALLER","WORKSPACE_ISOLATION","CORE_TESTS","HOST_PREFLIGHT","SELF_SERVICE_UI","DEMO_DRIVE","BROWSER_IDENTITY","INSTAGRAM_PREPARE","TIKTOK_PREPARE"]) q.recordGate({ runId: luca.runId, gate, passed: true, now: "2026-08-26T20:02:00Z", operatorId: "tester", summary: "pass" });
    assert.equal(q.finalize(luca.runId).status, "PASSED");
    assert.doesNotThrow(() => q.start({ runId: "run:fabian", releaseSha: sha, stage: "FABIAN_MAC", workspaceId: "fabian", hostFingerprint: "fabian-mac", now: "2026-08-26T20:03:00Z", operatorId: "tester" }));
    assert.throws(() => q.start({ releaseSha: sha, stage: "VPS_STAGING", workspaceId: "staging", hostFingerprint: "vps", now: "2026-08-26T20:04:00Z", operatorId: "tester" }), /predecessor stage FABIAN_MAC/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("qualification cannot pass with a missing or failed required gate", () => {
  const root = tempRoot();
  try {
    const reg = registry(root); const q = new ReleaseQualificationService(reg);
    const run = q.start({ runId: "run:x", releaseSha: "sha", stage: "LUCA_MAC", workspaceId: "luca", hostFingerprint: "mac", now: "2026-08-26T20:00:00Z", operatorId: "tester" });
    q.recordGate({ runId: run.runId, gate: "INSTALLER", passed: false, now: "2026-08-26T20:01:00Z", operatorId: "tester", summary: "installer failed" });
    assert.throws(() => q.finalize(run.runId), /missing gates/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("self-service UI creates an isolated workspace and refuses every typed-credential path", { timeout: 15000 }, async () => {
  const root = tempRoot(); const reg = registry(root);
  const fakeRunner = { supportedTests(){ return ["core","w8-harness","host-preflight"]; }, async run(id){ return { passed: true, summary: `${id} passed`, artifactRefs: [] }; } };
  const server = new SelfServiceHttpServer(reg, { runtimeRoot: root, repoRoot: resolve("."), password: "pw", username: "owner", chromiumExecutablePath: "/bin/false", testRunner: fakeRunner });
  try {
    const bound = await server.start(); const base = `http://127.0.0.1:${bound.port}`; const auth = `Basic ${Buffer.from("owner:pw").toString("base64")}`;
    assert.equal((await fetch(base)).status, 401);
    const html = await (await fetch(base, { headers: { authorization: auth } })).text();
    const csrf = html.match(/name=csrf value=([a-f0-9]+)/)?.[1]; assert.ok(csrf);

    const form = (body) => ({ method: "POST", redirect: "manual", headers: { authorization: auth, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf, ...body }) });
    assert.equal((await fetch(base + "/workspaces", form({ workspaceId: "brother", displayName: "Brother", timezone: "Europe/Vienna" }))).status, 303);

    const workspaceHtml = await (await fetch(base + "/workspaces/brother", { headers: { authorization: auth } })).text();
    assert.match(workspaceHtml, /Quelle/);
    // With no source configured at all, step 1 must name both routes -- including the one that
    // needs no credential, so nobody concludes an OAuth client is mandatory.
    assert.match(workspaceHtml, /source-root/);
    assert.match(workspaceHtml, /GOOGLE_OAUTH_CLIENT_ID/);
    assert.match(workspaceHtml, /Test Lab/);
    assert.match(workspaceHtml, /Workspace-Isolation/);

    // The routes that used to accept a folder id and a handle as free text are gone, not merely
    // hidden: setup reads those from Drive and from the live session instead.
    assert.equal((await fetch(base + "/workspaces/brother/drive", form({ rootFolderId: "drive-demo-root" }))).status, 404);
    assert.equal((await fetch(base + "/workspaces/brother/accounts", form({ platform: "instagram", accountId: "ig_primary", expectedHandle: "brother_test" }))).status, 404);

    const layout = workspaceRuntimeLayout(root, "brother");
    const store = new SqliteControlPlaneStore(layout.databasePath);
    try {
      assert.deepEqual(store.listSocialAccounts(), [], "no account can exist without a discovered session");
      assert.deepEqual(store.listChannelSourceBindings(), []);
    } finally { store.close(); }
  } finally { await server.stop(); rmSync(root, { recursive: true, force: true }); }
});

test("self-service Test Lab only runs allowlisted safe test ids and records result", { timeout: 15000 }, async () => {
  const root = tempRoot(); const reg = registry(root); new WorkspaceService(reg, root).create({ workspaceId: "luca", displayName: "Luca", now: "2026-08-26T20:00:00Z" });
  const calls=[]; const fakeRunner={ supportedTests(){return["core","w8-harness","host-preflight"];}, async run(id){calls.push(id);return{passed:true,summary:"ok",artifactRefs:[]};} };
  const server=new SelfServiceHttpServer(reg,{runtimeRoot:root,repoRoot:resolve("."),password:"pw",username:"owner",chromiumExecutablePath:"/bin/false",testRunner:fakeRunner});
  try { const bound=await server.start();const base=`http://127.0.0.1:${bound.port}`;const auth=`Basic ${Buffer.from("owner:pw").toString("base64")}`;const page=await fetch(base,{headers:{authorization:auth}});const csrf=(await page.text()).match(/name=csrf value=([a-f0-9]+)/)?.[1];assert.ok(csrf);
    const ok=await fetch(base+"/workspaces/luca/tests/core",{method:"POST",redirect:"manual",headers:{authorization:auth,"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({csrf})});assert.equal(ok.status,303);assert.deepEqual(calls,["core"]);
    const bad=await fetch(base+"/workspaces/luca/tests/not-allowed",{method:"POST",headers:{authorization:auth,"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({csrf})});assert.equal(bad.status,409);assert.match(await bad.text(),/Unknown self-service test/);
  } finally { await server.stop(); rmSync(root,{recursive:true,force:true}); }
});
