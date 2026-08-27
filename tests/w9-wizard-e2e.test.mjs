import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SelfServiceHttpServer } from "../dist/adapters/setup/self-service-http.js";
import { JsonWorkspaceRegistry } from "../dist/adapters/workspace/json-registry.js";
import { SqliteControlPlaneStore } from "../dist/adapters/storage/sqlite.js";
import { GoogleDriveFolderBrowser, DRIVE_ROOT } from "../dist/adapters/ingress/google-drive/google-drive-browser.js";
import { findChromiumExecutable } from "../dist/adapters/browser/resolve-chromium.js";
import { workspaceRuntimeLayout, initializeWorkspaceRuntime } from "../dist/application/workspaces.js";

const REAL_CHROMIUM = findChromiumExecutable();
const PASSWORD = "e2e-secret";
const AUTH = "Basic " + Buffer.from(`flerdvision:${PASSWORD}`).toString("base64");

const DRIVE = {
  root: { name: "Meine Ablage", children: ["fld_flerd"] },
  fld_flerd: { name: "Flerdvision", parent: DRIVE_ROOT, children: ["fld_ig"] },
  fld_ig: { name: "Instagram Luca", parent: "fld_flerd", children: [], files: [
    { id: "f1", name: "reel_0824.mp4", mimeType: "video/mp4", modifiedTime: "2026-08-24T10:00:00Z" },
    { id: "f2", name: "reel_0819.mp4", mimeType: "video/mp4", modifiedTime: "2026-08-19T10:00:00Z" },
    { id: "f3", name: "caption.txt", mimeType: "text/plain", modifiedTime: "2026-08-01T10:00:00Z" }
  ] }
};

function fakeDriveHttp() {
  const calls = [];
  return {
    calls,
    async getJson(url) {
      calls.push(url);
      const parsed = new URL(url);
      const q = parsed.searchParams.get("q");
      if (q) {
        const parent = /'([^']+)' in parents/.exec(q)?.[1];
        const node = DRIVE[parent];
        if (!node) return { status: 404, body: {} };
        const folders = (node.children ?? []).map((id) => ({ id, name: DRIVE[id].name, mimeType: "application/vnd.google-apps.folder" }));
        return { status: 200, body: { files: [...folders, ...(node.files ?? [])] } };
      }
      const id = decodeURIComponent(parsed.pathname.split("/").pop());
      const node = DRIVE[id];
      if (!node) return { status: 404, body: {} };
      return { status: 200, body: { id, name: node.name, mimeType: "application/vnd.google-apps.folder", parents: node.parent ? [node.parent] : [] } };
    },
    async postForm() { return { status: 200, body: {} }; }
  };
}

function fakeOAuth() {
  return {
    begin() { return { state: "state-1", codeVerifier: "verifier-1", authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?fake=1" }; },
    async complete() { return { clientId: "client-1", refreshToken: "refresh-1", connectedAccount: "luca@flerdvision.at", connectedAt: "2026-08-26T19:00:00Z" }; }
  };
}

function fakeDiscovery(channels, state = "HEALTHY") {
  return {
    async discover(_session, platform, now) {
      return { platform, state, discoveredAt: now, currentUrl: "https://www.instagram.com/accounts/edit/", channels };
    }
  };
}

async function harness(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "flerdvision-wizard-"));
  const registry = new JsonWorkspaceRegistry(join(dir, "registry", "workspaces.json"));
  const http = fakeDriveHttp();
  const server = new SelfServiceHttpServer(registry, {
    runtimeRoot: dir,
    repoRoot: process.cwd(),
    password: PASSWORD,
    chromiumExecutablePath: REAL_CHROMIUM ?? "/nonexistent",
    headlessLogin: true,
    testRunner: {
      supportedTests: () => ["core", "w8-harness", "host-preflight"],
      run: async (testId) => ({ passed: true, summary: `${testId} ok`, artifactRefs: [] })
    },
    folderBrowser: new GoogleDriveFolderBrowser({ http, token: { async accessToken() { return "token-1"; } } }),
    driveOAuth: fakeOAuth(),
    ...overrides
  });
  const { host, port } = await server.start();
  const base = `http://${host}:${port}`;
  const get = (path) => fetch(`${base}${path}`, { headers: { Authorization: AUTH }, redirect: "manual" });
  const post = (path, fields) => fetch(`${base}${path}`, {
    method: "POST", redirect: "manual",
    headers: { Authorization: AUTH, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf: server.csrf ?? "", ...fields }).toString()
  });
  return { dir, server, base, get, post, http, close: async () => { await server.stop(); rmSync(dir, { recursive: true, force: true }); } };
}

test("legacy wizard still proves Drive + browser + discovery but source/account binding is retired", { skip: REAL_CHROMIUM === undefined, timeout: 90_000 }, async () => {
  const h = await harness({ channelDiscovery: fakeDiscovery([
    { channelKey: "flerdvision", handle: "@flerdvision", displayName: "Flerdvision", detail: "Creator" },
    { channelKey: "fvtest", handle: "@fv.test", displayName: "FV Testkanal" }
  ]) });
  try {
    assert.equal((await fetch(`${h.base}/`, { redirect: "manual" })).status, 401);
    let res = await h.post("/workspaces", { workspaceId: "luca", displayName: "Luca", timezone: "Europe/Vienna" });
    assert.equal(res.status, 303);
    initializeWorkspaceRuntime(h.dir, "luca");

    res = await h.post("/workspaces/luca/bind", { accountId: "instagram_flerdvision" });
    assert.equal(res.status, 409);
    assert.match(await res.text(), /BLOCKED/);
    assert.equal((await h.get("/workspaces/luca/browse?folderId=root")).status, 409);

    assert.equal((await h.get("/workspaces/luca/drive/callback?code=auth-code&state=nope")).status, 409);
    await h.post("/workspaces/luca/drive/connect", {});
    assert.equal((await h.get("/workspaces/luca/drive/callback?code=auth-code&state=state-1")).status, 303);
    let page = await (await h.get("/workspaces/luca")).text();
    assert.match(page, /Google Drive verbunden/);
    assert.doesNotMatch(page, /refresh-1/);

    page = await (await h.get(`/workspaces/luca/browse?folderId=${DRIVE_ROOT}`)).text(); assert.match(page, /Flerdvision/);
    page = await (await h.get("/workspaces/luca/browse?folderId=fld_flerd")).text(); assert.match(page, /Instagram Luca/);
    page = await (await h.get("/workspaces/luca/browse?folderId=fld_ig")).text(); assert.match(page, /reel_0824\.mp4/);
    res = await h.post("/workspaces/luca/folder", { folderId: "fld_ig", folderPath: "Meine Ablage / Flerdvision / Instagram Luca" });
    assert.equal(res.status, 303);
    assert.match(await (await h.get("/workspaces/luca")).text(), /2 Videos/);

    assert.equal((await h.post("/workspaces/luca/channel", { channelKey: "flerdvision" })).status, 409);
    res = await h.post("/workspaces/luca/browser/open", { platform: "instagram", slot: "primary" });
    assert.equal(res.status, 303, await res.text());
    const loginProfile = join(workspaceRuntimeLayout(h.dir, "luca").profilesDir, "instagram", "login-primary");
    assert.ok(existsSync(loginProfile));
    assert.equal((await h.post("/workspaces/luca/discover", {})).status, 303);
    page = await (await h.get("/workspaces/luca")).text();
    assert.match(page, /@flerdvision/); assert.match(page, /@fv\.test/);
    assert.equal((await h.post("/workspaces/luca/channel", { channelKey: "typed_by_hand" })).status, 409);
    res = await h.post("/workspaces/luca/channel", { channelKey: "flerdvision" });
    assert.equal(res.status, 303, await res.text());

    const store = new SqliteControlPlaneStore(workspaceRuntimeLayout(h.dir, "luca").databasePath);
    try {
      const accounts = store.listSocialAccounts(); assert.equal(accounts.length, 1); assert.equal(accounts[0].account.accountId, "instagram_flerdvision");
      const identity = store.listBrowserIdentities()[0]; assert.equal(identity.identity.profileKey, "instagram/flerdvision");
      const channelProfile = join(workspaceRuntimeLayout(h.dir, "luca").profilesDir, "instagram", "flerdvision");
      assert.ok(existsSync(channelProfile)); assert.ok(readdirSync(channelProfile).length > 0);
      assert.ok(readdirSync(channelProfile).some((name) => readdirSync(loginProfile).includes(name)));
      assert.equal(store.latestSessionHealth(identity.identity.identityId).observedHandle, "flerdvision");
      assert.deepEqual(store.listChannelSourceBindings(), [], "channel discovery/registration must not create routing state");
    } finally { store.close(); }

    // Retired legacy action must remain impossible even after all old prerequisites are satisfied.
    res = await h.post("/workspaces/luca/bind", { accountId: "instagram_flerdvision", interpretSubstructure: "on" });
    assert.equal(res.status, 409);
    assert.match(await res.text(), /LEGACY_SOURCE_BINDING_DISABLED/);
    const verify = new SqliteControlPlaneStore(workspaceRuntimeLayout(h.dir, "luca").databasePath);
    try { assert.deepEqual(verify.listChannelSourceBindings(), []); } finally { verify.close(); }

    page = await (await h.get("/workspaces/luca")).text();
    assert.doesNotMatch(page, /Schritt <strong>READY<\/strong>/, "legacy wizard can no longer declare product routing ready");

    // Local engineering tests remain available because they do not require legacy binding.
    res = await h.post("/workspaces/luca/tests/core", {});
    assert.equal(res.status, 303);
    assert.match(await (await h.get("/workspaces/luca")).text(), /BESTANDEN/);
  } finally { await h.close(); }
});

test("an unhealthy session offers no channel and blocks the step", { skip: REAL_CHROMIUM === undefined, timeout: 60_000 }, async () => {
  const h = await harness({ channelDiscovery: fakeDiscovery([], "AUTH_REQUIRED") });
  try {
    await h.post("/workspaces", { workspaceId: "luca", displayName: "Luca", timezone: "Europe/Vienna" }); initializeWorkspaceRuntime(h.dir, "luca");
    await h.post("/workspaces/luca/drive/connect", {}); await h.get("/workspaces/luca/drive/callback?code=c&state=state-1");
    await h.post("/workspaces/luca/folder", { folderId: "fld_ig", folderPath: "Meine Ablage / Flerdvision / Instagram Luca" });
    await h.post("/workspaces/luca/browser/open", { platform: "instagram", slot: "primary" }); await h.post("/workspaces/luca/discover", {});
    const page = await (await h.get("/workspaces/luca")).text(); assert.match(page, /AUTH_REQUIRED/); assert.match(page, /hier wird nichts geraten/);
    assert.equal((await h.post("/workspaces/luca/channel", { channelKey: "flerdvision" })).status, 409);
  } finally { await h.close(); }
});

test("without calibrated discovery the wizard refuses rather than offering a text field", async () => {
  const h = await harness();
  try {
    await h.post("/workspaces", { workspaceId: "luca", displayName: "Luca", timezone: "Europe/Vienna" }); initializeWorkspaceRuntime(h.dir, "luca");
    await h.post("/workspaces/luca/drive/connect", {}); await h.get("/workspaces/luca/drive/callback?code=c&state=state-1");
    await h.post("/workspaces/luca/folder", { folderId: "fld_ig", folderPath: "A / B" });
    const page = await (await h.get("/workspaces/luca")).text(); assert.doesNotMatch(page, /name=expectedHandle/); assert.doesNotMatch(page, /name=accountId[^s]/);
  } finally { await h.close(); }
});

test("the Drive browser reads a folder through the API and previews it", async () => {
  const http = fakeDriveHttp(); const browser = new GoogleDriveFolderBrowser({ http, token: { async accessToken() { return "t"; } } });
  const listing = await browser.listFolder("fld_flerd"); assert.equal(listing.folderName, "Flerdvision"); assert.deepEqual(listing.path.map((c) => c.name), ["Meine Ablage", "Flerdvision"]); assert.deepEqual(listing.entries.map((e) => e.name), ["Instagram Luca"]);
  const preview = await browser.previewFolder("fld_ig"); assert.equal(preview.videoCount, 2); assert.equal(preview.otherCount, 1); assert.equal(preview.newestName, "reel_0824.mp4");
  assert.ok(http.calls.every((u) => u.startsWith("https://www.googleapis.com/drive/v3/")));
});

test("an expired Drive credential surfaces as a reconnect instruction, not a stack trace", async () => {
  const browser = new GoogleDriveFolderBrowser({ http: { async getJson() { return { status: 401, body: { error: "invalid_grant" } }; }, async postForm() { return { status: 200, body: {} }; } }, token: { async accessToken() { return "stale"; } } });
  await assert.rejects(() => browser.listFolder("fld_ig"), /Reconnect the workspace/);
});

test("a refused channel key leaves no trace and does not strand the login session", { skip: REAL_CHROMIUM === undefined, timeout: 60_000 }, async () => {
  const h = await harness({ channelDiscovery: fakeDiscovery([{ channelKey: "flerdvision", handle: "@flerdvision", displayName: "Flerdvision" }]) });
  try {
    await h.post("/workspaces", { workspaceId: "luca", displayName: "Luca", timezone: "Europe/Vienna" }); initializeWorkspaceRuntime(h.dir, "luca");
    await h.post("/workspaces/luca/drive/connect", {}); await h.get("/workspaces/luca/drive/callback?code=c&state=state-1");
    await h.post("/workspaces/luca/folder", { folderId: "fld_ig", folderPath: "Meine Ablage / Flerdvision / Instagram Luca" });
    await h.post("/workspaces/luca/browser/open", { platform: "instagram", slot: "primary" }); await h.post("/workspaces/luca/discover", {});
    const profilesDir = workspaceRuntimeLayout(h.dir, "luca").profilesDir; const before = readdirSync(join(profilesDir, "instagram"));
    for (const bogus of ["typed_by_hand", "flerdvision_typo", "UCsomethingElse"]) assert.equal((await h.post("/workspaces/luca/channel", { channelKey: bogus })).status, 409);
    assert.deepEqual(readdirSync(join(profilesDir, "instagram")).sort(), before.sort());
    const res = await h.post("/workspaces/luca/channel", { channelKey: "flerdvision" }); assert.equal(res.status, 303, await res.text());
    assert.ok(readdirSync(join(profilesDir, "instagram", "flerdvision")).length > 0);
  } finally { await h.close(); }
});

test("a mounted folder works as a source without any credential", async () => {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { LocalFolderBrowser, LOCAL_ROOT } = await import("../dist/adapters/ingress/local/local-folder-browser.js");
  const root = mkdtempSync(join(tmpdir(), "mount-"));
  try {
    mkdirSync(join(root, "Flerdvision", "Reels"), { recursive: true });
    writeFileSync(join(root, "Flerdvision", "Reels", "reel_0824.mp4"), "x"); writeFileSync(join(root, "Flerdvision", "Reels", "reel_0819.mov"), "x"); writeFileSync(join(root, "Flerdvision", "Reels", "caption.txt"), "x"); writeFileSync(join(root, "Flerdvision", ".DS_Store"), "x");
    const browser = new LocalFolderBrowser({ root, rootLabel: "Mein Mount" });
    const top = await browser.listFolder(LOCAL_ROOT); assert.equal(top.folderName, "Mein Mount"); assert.deepEqual(top.entries.map((e) => e.name), ["Flerdvision"]);
    const mid = await browser.listFolder(top.entries[0].id); assert.deepEqual(mid.entries.map((e) => e.name), ["Reels"]); assert.deepEqual(mid.path.map((c) => c.name), ["Mein Mount", "Flerdvision"]);
    const leaf = await browser.listFolder(mid.entries[0].id); assert.deepEqual(leaf.entries.map((e) => e.name), ["caption.txt", "reel_0819.mov", "reel_0824.mp4"]);
    const preview = await browser.previewFolder(mid.entries[0].id); assert.equal(preview.videoCount, 2); assert.equal(preview.otherCount, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a local source cannot be walked out of its configured root", async () => {
  const { LocalFolderBrowser } = await import("../dist/adapters/ingress/local/local-folder-browser.js");
  const root = mkdtempSync(join(tmpdir(), "mount-"));
  try {
    const browser = new LocalFolderBrowser({ root });
    for (const escape of ["../../etc", "..", "/etc"]) {
      const token = Buffer.from(escape, "utf8").toString("base64url");
      await assert.rejects(() => browser.listFolder(token), /Unsafe folder id|escaped the configured source root|not readable|Not a folder/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
