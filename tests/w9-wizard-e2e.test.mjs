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

/* ---------- a Drive that answers from a fixture instead of the network ---------- */

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

/* ---------- harness ---------- */

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

/* ---------- the walk ---------- */

test("wizard end to end: connect, browse, pick, log in, discover, confirm, bind, test", { skip: REAL_CHROMIUM === undefined, timeout: 90_000 }, async () => {
  const h = await harness({
    channelDiscovery: fakeDiscovery([
      { channelKey: "flerdvision", handle: "@flerdvision", displayName: "Flerdvision", detail: "Creator" },
      { channelKey: "fvtest", handle: "@fv.test", displayName: "FV Testkanal" }
    ])
  });
  try {
    // 0 · unauthenticated requests never reach the wizard
    const anon = await fetch(`${h.base}/`, { redirect: "manual" });
    assert.equal(anon.status, 401);

    // 1 · a workspace exists before anything else
    let res = await h.post("/workspaces", { workspaceId: "luca", displayName: "Luca", timezone: "Europe/Vienna" });
    assert.equal(res.status, 303);
    initializeWorkspaceRuntime(h.dir, "luca");

    // GATE · binding before any of it is refused, and the refusal names the missing step
    res = await h.post("/workspaces/luca/bind", { accountId: "instagram_flerdvision" });
    assert.equal(res.status, 409);
    assert.match(await res.text(), /BLOCKED/);

    // GATE · browsing before Drive is connected is refused
    res = await h.get("/workspaces/luca/browse?folderId=root");
    assert.equal(res.status, 409);

    // 2 · connect Drive through the callback, exactly as Google would return
    res = await h.get("/workspaces/luca/drive/callback?code=auth-code&state=nope");
    assert.equal(res.status, 409, "a mismatched state must be rejected");
    await h.post("/workspaces/luca/drive/connect", {});
    res = await h.get("/workspaces/luca/drive/callback?code=auth-code&state=state-1");
    assert.equal(res.status, 303);

    let page = await (await h.get("/workspaces/luca")).text();
    assert.match(page, /Google Drive verbunden/);
    assert.doesNotMatch(page, /refresh-1/, "the refresh token must never reach the page");

    // 3 · browse into a real folder tree and pick a folder
    page = await (await h.get(`/workspaces/luca/browse?folderId=${DRIVE_ROOT}`)).text();
    assert.match(page, /Flerdvision/);
    page = await (await h.get("/workspaces/luca/browse?folderId=fld_flerd")).text();
    assert.match(page, /Instagram Luca/);
    page = await (await h.get("/workspaces/luca/browse?folderId=fld_ig")).text();
    assert.match(page, /reel_0824\.mp4/);

    res = await h.post("/workspaces/luca/folder", { folderId: "fld_ig", folderPath: "Meine Ablage / Flerdvision / Instagram Luca" });
    assert.equal(res.status, 303);
    page = await (await h.get("/workspaces/luca")).text();
    assert.match(page, /2 Videos/, "the preview proves the connection before the operator moves on");

    // GATE · confirming a channel before a session exists is refused
    res = await h.post("/workspaces/luca/channel", { channelKey: "flerdvision" });
    assert.equal(res.status, 409);

    // 4 · open the real login browser, then read the session
    res = await h.post("/workspaces/luca/browser/open", { platform: "instagram", slot: "primary" });
    assert.equal(res.status, 303, await res.text());
    const loginProfile = join(workspaceRuntimeLayout(h.dir, "luca").profilesDir, "instagram", "login-primary");
    assert.ok(existsSync(loginProfile), "the login profile is created before any account exists");

    res = await h.post("/workspaces/luca/discover", {});
    assert.equal(res.status, 303);
    page = await (await h.get("/workspaces/luca")).text();
    assert.match(page, /@flerdvision/);
    assert.match(page, /@fv\.test/, "both discovered channels are offered");

    // GATE · a channel that was never discovered cannot be confirmed
    res = await h.post("/workspaces/luca/channel", { channelKey: "typed_by_hand" });
    assert.equal(res.status, 409);

    // 5 · confirm the real one
    res = await h.post("/workspaces/luca/channel", { channelKey: "flerdvision" });
    assert.equal(res.status, 303, await res.text());

    const store = new SqliteControlPlaneStore(workspaceRuntimeLayout(h.dir, "luca").databasePath);
    try {
      const accounts = store.listSocialAccounts();
      assert.equal(accounts.length, 1);
      assert.equal(accounts[0].account.accountId, "instagram_flerdvision");
      assert.equal(accounts[0].account.expectedHandle, "flerdvision");
      const identity = store.listBrowserIdentities()[0];
      assert.equal(identity.identity.profileKey, "instagram/flerdvision");
      // The login carried over: the channel profile was seeded from it, not created empty.
      // Existence alone is not proof -- the resolver creates directories on sight.
      const channelProfile = join(workspaceRuntimeLayout(h.dir, "luca").profilesDir, "instagram", "flerdvision");
      assert.ok(existsSync(channelProfile), `channel profile directory missing; profiles/=${JSON.stringify(readdirSync(workspaceRuntimeLayout(h.dir,"luca").profilesDir))} instagram/=${existsSync(join(workspaceRuntimeLayout(h.dir,"luca").profilesDir,"instagram"))?JSON.stringify(readdirSync(join(workspaceRuntimeLayout(h.dir,"luca").profilesDir,"instagram"))):"FEHLT"}`);
      assert.ok(readdirSync(channelProfile).length > 0, "channel profile is empty: the login did not carry over");
      assert.ok(
        readdirSync(channelProfile).some((name) => readdirSync(loginProfile).includes(name)),
        "channel profile does not contain what the login profile held"
      );
      assert.equal(store.latestSessionHealth(identity.identity.identityId).observedHandle, "flerdvision");
    } finally { store.close(); }

    // 6 · bind folder to channel
    res = await h.post("/workspaces/luca/bind", { accountId: "instagram_flerdvision", interpretSubstructure: "on" });
    assert.equal(res.status, 303, await res.text());

    const store2 = new SqliteControlPlaneStore(workspaceRuntimeLayout(h.dir, "luca").databasePath);
    try {
      const binding = store2.getChannelSourceBindingForAccount("instagram_flerdvision");
      assert.equal(binding.binding.folderId, "fld_ig");
      assert.equal(binding.binding.interpretSubstructure, true);
    } finally { store2.close(); }

    page = await (await h.get("/workspaces/luca")).text();
    assert.match(page, /Schritt <strong>READY<\/strong>/);

    // 7 · the local tests run and record
    res = await h.post("/workspaces/luca/tests/core", {});
    assert.equal(res.status, 303);
    page = await (await h.get("/workspaces/luca")).text();
    assert.match(page, /BESTANDEN/);
  } finally {
    await h.close();
  }
});

test("an unhealthy session offers no channel and blocks the step", { skip: REAL_CHROMIUM === undefined, timeout: 60_000 }, async () => {
  const h = await harness({ channelDiscovery: fakeDiscovery([], "AUTH_REQUIRED") });
  try {
    await h.post("/workspaces", { workspaceId: "luca", displayName: "Luca", timezone: "Europe/Vienna" });
    initializeWorkspaceRuntime(h.dir, "luca");
    await h.post("/workspaces/luca/drive/connect", {});
    await h.get("/workspaces/luca/drive/callback?code=c&state=state-1");
    await h.post("/workspaces/luca/folder", { folderId: "fld_ig", folderPath: "Meine Ablage / Flerdvision / Instagram Luca" });
    await h.post("/workspaces/luca/browser/open", { platform: "instagram", slot: "primary" });
    await h.post("/workspaces/luca/discover", {});

    const page = await (await h.get("/workspaces/luca")).text();
    assert.match(page, /AUTH_REQUIRED/);
    assert.match(page, /hier wird nichts geraten/);

    const res = await h.post("/workspaces/luca/channel", { channelKey: "flerdvision" });
    assert.equal(res.status, 409);
  } finally {
    await h.close();
  }
});

test("without calibrated discovery the wizard refuses rather than offering a text field", async () => {
  const h = await harness();
  try {
    await h.post("/workspaces", { workspaceId: "luca", displayName: "Luca", timezone: "Europe/Vienna" });
    initializeWorkspaceRuntime(h.dir, "luca");
    await h.post("/workspaces/luca/drive/connect", {});
    await h.get("/workspaces/luca/drive/callback?code=c&state=state-1");
    await h.post("/workspaces/luca/folder", { folderId: "fld_ig", folderPath: "A / B" });

    const page = await (await h.get("/workspaces/luca")).text();
    // No route accepts a handle, on any step.
    assert.doesNotMatch(page, /name=expectedHandle/);
    assert.doesNotMatch(page, /name=accountId[^s]/);
  } finally {
    await h.close();
  }
});

test("the Drive browser reads a folder through the API and previews it", async () => {
  const http = fakeDriveHttp();
  const browser = new GoogleDriveFolderBrowser({ http, token: { async accessToken() { return "t"; } } });

  const listing = await browser.listFolder("fld_flerd");
  assert.equal(listing.folderName, "Flerdvision");
  assert.deepEqual(listing.path.map((c) => c.name), ["Meine Ablage", "Flerdvision"]);
  assert.deepEqual(listing.entries.map((e) => e.name), ["Instagram Luca"]);

  const preview = await browser.previewFolder("fld_ig");
  assert.equal(preview.videoCount, 2);
  assert.equal(preview.otherCount, 1);
  assert.equal(preview.newestName, "reel_0824.mp4");

  assert.ok(http.calls.every((u) => u.startsWith("https://www.googleapis.com/drive/v3/")));
});

test("an expired Drive credential surfaces as a reconnect instruction, not a stack trace", async () => {
  const browser = new GoogleDriveFolderBrowser({
    http: { async getJson() { return { status: 401, body: { error: "invalid_grant" } }; }, async postForm() { return { status: 200, body: {} }; } },
    token: { async accessToken() { return "stale"; } }
  });
  await assert.rejects(() => browser.listFolder("fld_ig"), /Reconnect the workspace/);
});

test("a refused channel key leaves no trace and does not strand the login session", { skip: REAL_CHROMIUM === undefined, timeout: 60_000 }, async () => {
  const h = await harness({ channelDiscovery: fakeDiscovery([{ channelKey: "flerdvision", handle: "@flerdvision", displayName: "Flerdvision" }]) });
  try {
    await h.post("/workspaces", { workspaceId: "luca", displayName: "Luca", timezone: "Europe/Vienna" });
    initializeWorkspaceRuntime(h.dir, "luca");
    await h.post("/workspaces/luca/drive/connect", {});
    await h.get("/workspaces/luca/drive/callback?code=c&state=state-1");
    await h.post("/workspaces/luca/folder", { folderId: "fld_ig", folderPath: "Meine Ablage / Flerdvision / Instagram Luca" });
    await h.post("/workspaces/luca/browser/open", { platform: "instagram", slot: "primary" });
    await h.post("/workspaces/luca/discover", {});

    const profilesDir = workspaceRuntimeLayout(h.dir, "luca").profilesDir;
    const before = readdirSync(join(profilesDir, "instagram"));

    // Rejecting must happen before anything is touched. Creating a directory named from the
    // rejected input, or closing the browser the operator is about to reuse, turns a refusal
    // into a real side effect.
    for (const bogus of ["typed_by_hand", "flerdvision_typo", "UCsomethingElse"]) {
      const res = await h.post("/workspaces/luca/channel", { channelKey: bogus });
      assert.equal(res.status, 409, `${bogus} must be refused`);
    }

    assert.deepEqual(readdirSync(join(profilesDir, "instagram")).sort(), before.sort(),
      "a refused channel key must not create a profile directory");

    // The session survived, so the legitimate confirmation still works without logging in again.
    const res = await h.post("/workspaces/luca/channel", { channelKey: "flerdvision" });
    assert.equal(res.status, 303, await res.text());
    const seeded = join(profilesDir, "instagram", "flerdvision");
    assert.ok(readdirSync(seeded).length > 0, "the login must still carry over after a refused attempt");
  } finally {
    await h.close();
  }
});

/* ---------- a source that needs no credential at all ---------- */

test("a mounted folder works as a source without any credential", async () => {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { LocalFolderBrowser, LOCAL_ROOT } = await import("../dist/adapters/ingress/local/local-folder-browser.js");
  const root = mkdtempSync(join(tmpdir(), "mount-"));
  try {
    mkdirSync(join(root, "Flerdvision", "Reels"), { recursive: true });
    writeFileSync(join(root, "Flerdvision", "Reels", "reel_0824.mp4"), "x");
    writeFileSync(join(root, "Flerdvision", "Reels", "reel_0819.mov"), "x");
    writeFileSync(join(root, "Flerdvision", "Reels", "caption.txt"), "x");
    writeFileSync(join(root, "Flerdvision", ".DS_Store"), "x");

    const browser = new LocalFolderBrowser({ root, rootLabel: "Mein Mount" });
    const top = await browser.listFolder(LOCAL_ROOT);
    assert.equal(top.folderName, "Mein Mount");
    assert.deepEqual(top.entries.map((e) => e.name), ["Flerdvision"]);

    const mid = await browser.listFolder(top.entries[0].id);
    assert.deepEqual(mid.entries.map((e) => e.name), ["Reels"], "dotfiles stay hidden");
    assert.deepEqual(mid.path.map((c) => c.name), ["Mein Mount", "Flerdvision"]);

    const leaf = await browser.listFolder(mid.entries[0].id);
    assert.deepEqual(leaf.entries.map((e) => e.name), ["caption.txt", "reel_0819.mov", "reel_0824.mp4"]);

    const preview = await browser.previewFolder(mid.entries[0].id);
    assert.equal(preview.videoCount, 2, ".mp4 and .mov count as video, .txt does not");
    assert.equal(preview.otherCount, 1);

    // Folder ids stay opaque tokens the binding layer accepts.
    const { assertFolderId } = await import("../dist/domain/source-binding.js");
    for (const entry of [...top.entries, ...mid.entries]) assertFolderId(entry.id);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("one folder feeds Instagram and TikTok; each channel still watches exactly one folder", async () => {
  const { SetupChannelRegistrationService } = await import("../dist/application/setup-channel-registration.js");
  const { ChannelSourceBindingConflictError } = await import("../dist/domain/source-binding.js");
  const dir = mkdtempSync(join(tmpdir(), "crosspost-"));
  const store = new SqliteControlPlaneStore(join(dir, "db.sqlite"));
  try {
    const service = new SetupChannelRegistrationService(store);
    const actor = { type: "test", id: "crosspost" };
    const register = (platform, key, handle, checkId) => service.registerFromDiscovery({
      result: { platform, state: "HEALTHY", discoveredAt: "2026-08-26T20:00:00Z", channels: [{ channelKey: key, handle, displayName: handle }] },
      channelKey: key, checkId, now: "2026-08-26T20:00:01Z", actor
    });

    const ig = register("instagram", "flerdvision", "@flerdvision", "c1");
    const tt = register("tiktok", "flerdvisionat", "@flerdvision.at", "c2");

    const folder = { folderId: "RmxlcmR2aXNpb24vUmVlbHM", folderPath: "Mein Mount / Flerdvision / Reels", interpretSubstructure: false, now: "2026-08-26T20:01:00Z", actor };
    service.bindSource({ ...folder, accountId: ig.accountId, bindingId: "bind:ig" });
    service.bindSource({ ...folder, accountId: tt.accountId, bindingId: "bind:tt" });

    // The same video therefore reaches both channels from one drop.
    const fed = store.listChannelSourceBindingsForFolder(folder.folderId).map((b) => b.binding.accountId).sort();
    assert.deepEqual(fed, ["instagram_flerdvision", "tiktok_flerdvisionat"]);

    // The reverse stays impossible: a channel cannot listen to a second folder.
    assert.throws(
      () => service.bindSource({ ...folder, accountId: ig.accountId, bindingId: "bind:ig:2", folderId: "AnotherFolderToken" }),
      ChannelSourceBindingConflictError
    );

    // And the two channels keep separate browser profiles despite sharing a folder.
    const profiles = store.listBrowserIdentities().map((i) => i.identity.profileKey).sort();
    assert.deepEqual(profiles, ["instagram/flerdvision", "tiktok/flerdvisionat"]);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
