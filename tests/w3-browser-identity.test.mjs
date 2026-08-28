import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";

import {
  BrowserIdentityConflictError,
  SocialAccountConflictError,
  SqliteControlPlaneStore
} from "../dist/adapters/storage/sqlite.js";
import {
  BrowserProfileDirectoryResolver,
  BrowserProfileLockedError,
  DurableBrowserProfileLockAdapter,
  FileBrowserProfileLockAdapter,
  UnsafeProfilePathError
} from "../dist/adapters/browser/profile-lock.js";
import { buildChromiumArgs, ChromiumCdpRuntimeAdapter } from "../dist/adapters/browser/chromium-cdp.js";
import { ConfiguredDomSessionProbe } from "../dist/adapters/browser/configured-dom-probe.js";
import { normalizeSocialHandle } from "../dist/domain/browser-identity.js";
import { BrowserBootstrapService } from "../dist/application/browser-bootstrap.js";
import {
  AccountIdentityGuard,
  AccountIdentityMismatchError,
  BrowserSessionHealthService,
  SessionNotReadyError
} from "../dist/application/browser-identity-service.js";
import { findChromiumExecutable } from "../dist/adapters/browser/resolve-chromium.js";

// A real browser is optional: CI hosts and containers may have none, and its path differs per OS.
const REAL_CHROMIUM = findChromiumExecutable();

function tempRuntime() {
  const dir = mkdtempSync(join(tmpdir(), "flerdvision-w3-"));
  return { dir, db: join(dir, "control.sqlite"), profiles: join(dir, "profiles") };
}

function account(overrides = {}) {
  return {
    accountId: "acct:test:ig",
    creatorId: "creator_test",
    platform: "instagram",
    expectedHandle: "@Test_Account",
    enabled: true,
    ...overrides
  };
}

function identity(overrides = {}) {
  return {
    identityId: "browser:acct:test:ig",
    accountId: "acct:test:ig",
    platform: "instagram",
    profileKey: "instagram/test-account",
    expectedHandle: "Test_Account",
    enabled: true,
    ...overrides
  };
}

function register(store) {
  store.registerSocialAccount(account(), "2026-08-26T16:00:00Z", { type: "test", id: "register" });
  store.registerBrowserIdentity(identity(), "2026-08-26T16:00:01Z", { type: "test", id: "register" });
}


test("social handle normalization accepts plain handles and supported profile URLs", () => {
  assert.equal(normalizeSocialHandle("@Some_User"), "some_user");
  assert.equal(normalizeSocialHandle("https://www.instagram.com/Some_User/"), "some_user");
  assert.equal(normalizeSocialHandle("https://www.tiktok.com/@Some_User"), "some_user");
  assert.equal(normalizeSocialHandle("https://youtube.com/@Some_User"), "some_user");
  assert.throws(() => normalizeSocialHandle("https://example.com/not-supported"), /Unsupported/);
});
test("social account and browser identity registration is durable and idempotent", () => {
  const runtime = tempRuntime();
  const store = new SqliteControlPlaneStore(runtime.db);
  try {
    const firstAccount = store.registerSocialAccount(account(), "2026-08-26T16:00:00Z", { type: "test", id: "first" });
    const secondAccount = store.registerSocialAccount(account({ expectedHandle: "test_account" }), "2026-08-26T16:00:01Z", { type: "test", id: "repeat" });
    assert.equal(firstAccount.created, true);
    assert.equal(secondAccount.created, false);
    assert.equal(secondAccount.record.account.expectedHandle, "test_account");

    const firstIdentity = store.registerBrowserIdentity(identity(), "2026-08-26T16:00:02Z", { type: "test", id: "first" });
    const secondIdentity = store.registerBrowserIdentity(identity({ expectedHandle: "@TEST_ACCOUNT" }), "2026-08-26T16:00:03Z", { type: "test", id: "repeat" });
    assert.equal(firstIdentity.created, true);
    assert.equal(secondIdentity.created, false);
    assert.equal(store.listBrowserIdentities().length, 1);
  } finally {
    store.close();
    rmSync(runtime.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
  }
});

test("conflicting account identity, profile reuse and platform mismatch fail closed", () => {
  const runtime = tempRuntime();
  const store = new SqliteControlPlaneStore(runtime.db);
  try {
    store.registerSocialAccount(account(), "2026-08-26T16:00:00Z", { type: "test", id: "base" });
    assert.throws(
      () => store.registerSocialAccount(account({ platform: "tiktok" }), "2026-08-26T16:00:01Z", { type: "test", id: "conflict" }),
      SocialAccountConflictError
    );
    store.registerBrowserIdentity(identity(), "2026-08-26T16:00:02Z", { type: "test", id: "base" });

    store.registerSocialAccount({ ...account(), accountId: "acct:other:ig", expectedHandle: "other" }, "2026-08-26T16:00:03Z", { type: "test", id: "other" });
    assert.throws(
      () => store.registerBrowserIdentity({ ...identity(), identityId: "browser:other", accountId: "acct:other:ig", expectedHandle: "other" }, "2026-08-26T16:00:04Z", { type: "test", id: "reuse" }),
      BrowserIdentityConflictError
    );

    store.registerSocialAccount({ accountId: "acct:yt", platform: "youtube", expectedHandle: "yt_test", enabled: true }, "2026-08-26T16:00:05Z", { type: "test", id: "yt" });
    assert.throws(
      () => store.registerBrowserIdentity({ ...identity(), identityId: "browser:yt", accountId: "acct:yt", platform: "instagram", expectedHandle: "yt_test", profileKey: "youtube/yt" }, "2026-08-26T16:00:06Z", { type: "test", id: "platform" }),
      BrowserIdentityConflictError
    );
  } finally {
    store.close();
    rmSync(runtime.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
  }
});

test("profile resolver blocks traversal and profile lock blocks concurrent browser use", () => {
  const runtime = tempRuntime();
  try {
    const resolver = new BrowserProfileDirectoryResolver(runtime.profiles);
    assert.throws(() => resolver.resolve("../escape"), UnsafeProfilePathError);
    assert.throws(() => resolver.resolve("/absolute"), UnsafeProfilePathError);
    const lockAdapter = new FileBrowserProfileLockAdapter(resolver);
    const first = lockAdapter.acquire(identity(), "worker-a", "2026-08-26T16:00:00Z");
    assert.throws(() => lockAdapter.acquire(identity(), "worker-b", "2026-08-26T16:00:01Z"), BrowserProfileLockedError);
    first.release();
    const second = lockAdapter.acquire(identity(), "worker-b", "2026-08-26T16:00:02Z");
    second.release();
  } finally {
    rmSync(runtime.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
  }
});

test("durable profile lease prevents concurrent identity use even with separate local lock adapters", () => {
  const runtime = tempRuntime();
  const store = new SqliteControlPlaneStore(runtime.db);
  try {
    register(store);
    const rootA = new BrowserProfileDirectoryResolver(join(runtime.dir, "profiles-a"));
    const rootB = new BrowserProfileDirectoryResolver(join(runtime.dir, "profiles-b"));
    const lockA = new DurableBrowserProfileLockAdapter(store, new FileBrowserProfileLockAdapter(rootA), 300);
    const lockB = new DurableBrowserProfileLockAdapter(store, new FileBrowserProfileLockAdapter(rootB), 300);
    const first = lockA.acquire(identity(), "worker-a", "2026-08-26T16:00:00Z");
    assert.throws(() => lockB.acquire(identity(), "worker-b", "2026-08-26T16:00:01Z"), BrowserProfileLockedError);
    first.heartbeat("2026-08-26T16:00:30Z");
    first.release();
    const second = lockB.acquire(identity(), "worker-b", "2026-08-26T16:00:31Z");
    second.release();
  } finally {
    store.close();
    rmSync(runtime.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
  }
});

test("chromium launch arguments keep remote debugging on localhost only", () => {
  const args = buildChromiumArgs("/safe/profile", { headless: false, initialUrl: "about:blank" });
  assert.ok(args.includes("--remote-debugging-address=127.0.0.1"));
  assert.ok(!args.some((value) => value.includes("0.0.0.0")));
  assert.ok(args.includes("--remote-debugging-port=0"));
  assert.ok(args.includes("--user-data-dir=/safe/profile"));
});

test("health checks are append-only and guard rejects auth-required, mismatch and missing checks", async () => {
  const runtime = tempRuntime();
  const store = new SqliteControlPlaneStore(runtime.db);
  try {
    register(store);
    const page = {
      identityId: identity().identityId,
      profileDirectory: runtime.profiles,
      async navigate() {},
      async currentUrl() { return "https://example.invalid/home"; },
      async evaluate() { return null; },
      async setCookie() {},
      async cookies() { return []; },
      async close() {}
    };
    const authService = new BrowserSessionHealthService(store, { async probe() { return { state: "AUTH_REQUIRED", currentUrl: "https://example.invalid/login" }; } });
    await authService.check(identity().identityId, page, "2026-08-26T16:01:00Z", { type: "test", id: "auth" });
    assert.throws(() => new AccountIdentityGuard(store).assertReady(identity().identityId), SessionNotReadyError);

    const mismatchService = new BrowserSessionHealthService(store, { async probe() { return { state: "HEALTHY", observedHandle: "someone_else", currentUrl: "https://example.invalid/home" }; } });
    const mismatch = await mismatchService.check(identity().identityId, page, "2026-08-26T16:02:00Z", { type: "test", id: "mismatch" });
    assert.equal(mismatch.state, "IDENTITY_MISMATCH");
    assert.throws(() => new AccountIdentityGuard(store).assertReady(identity().identityId), AccountIdentityMismatchError);

    const healthyService = new BrowserSessionHealthService(store, { async probe() { return { state: "HEALTHY", observedHandle: "@TEST_ACCOUNT", currentUrl: "https://example.invalid/home" }; } });
    const healthy = await healthyService.check(identity().identityId, page, "2026-08-26T16:03:00Z", { type: "test", id: "healthy" });
    assert.equal(healthy.state, "HEALTHY");
    assert.equal(new AccountIdentityGuard(store).assertReady(identity().identityId).state, "HEALTHY");
  } finally {
    store.close();
  }

  const raw = new DatabaseSync(runtime.db);
  try {
    assert.throws(() => raw.exec("UPDATE session_health_checks SET state = 'HEALTHY'"), /append-only/);
    assert.throws(() => raw.exec("DELETE FROM session_health_checks"), /append-only/);
  } finally {
    raw.close();
    rmSync(runtime.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
  }
});

test("real Chromium persistent cookie survives a full browser restart", { skip: REAL_CHROMIUM === undefined, timeout: 45_000 }, async () => {
  const runtimePaths = tempRuntime();
  const store = new SqliteControlPlaneStore(runtimePaths.db);
  register(store);
  const resolver = new BrowserProfileDirectoryResolver(runtimePaths.profiles);
  const locks = new FileBrowserProfileLockAdapter(resolver);
  const chromium = new ChromiumCdpRuntimeAdapter({ profilesRoot: runtimePaths.profiles, executablePath: REAL_CHROMIUM });
  const bootstrap = new BrowserBootstrapService(store, chromium, locks);
  const cookieUrl = "https://session-persistence.invalid/";
  const expires = Math.floor(Date.now() / 1000) + 3600;

  try {
    const first = await bootstrap.openForOperator({
      identityId: identity().identityId,
      ownerId: "w3-real-1",
      bootstrapUrl: "about:blank",
      now: "2026-08-26T16:10:00Z",
      headless: true
    });
    try {
      await first.page.setCookie(cookieUrl, "fv_session", "persisted", expires);
      const before = await first.page.cookies(cookieUrl);
      assert.equal(before.find((cookie) => cookie.name === "fv_session")?.value, "persisted");
    } finally {
      await first.close();
    }

    const second = await bootstrap.openForOperator({
      identityId: identity().identityId,
      ownerId: "w3-real-2",
      bootstrapUrl: "about:blank",
      now: "2026-08-26T16:11:00Z",
      headless: true
    });
    try {
      const after = await second.page.cookies(cookieUrl);
      assert.equal(after.find((cookie) => cookie.name === "fv_session")?.value, "persisted");
    } finally {
      await second.close();
    }
  } finally {
    store.close();
    // Chromium profile helpers can finish disk writes just after Browser.close.
    await new Promise((resolve) => setTimeout(resolve, 300));
    rmSync(runtimePaths.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
  }
});

test("real Chromium DOM probe classifies exact identity and auth marker without network access", { skip: REAL_CHROMIUM === undefined, timeout: 45_000 }, async () => {
  const runtimePaths = tempRuntime();
  const store = new SqliteControlPlaneStore(runtimePaths.db);
  register(store);
  const resolver = new BrowserProfileDirectoryResolver(runtimePaths.profiles);
  const bootstrap = new BrowserBootstrapService(
    store,
    new ChromiumCdpRuntimeAdapter({ profilesRoot: runtimePaths.profiles }),
    new FileBrowserProfileLockAdapter(resolver)
  );
  try {
    const operator = await bootstrap.openForOperator({
      identityId: identity().identityId,
      ownerId: "w3-dom-probe",
      bootstrapUrl: "about:blank",
      now: "2026-08-26T16:12:00Z",
      headless: true
    });
    try {
      await operator.page.evaluate(`document.body.innerHTML = '<div id="account" data-handle="@test_account">ok</div>'`);
      const healthyProbe = new ConfiguredDomSessionProbe({
        probeUrl: "about:blank",
        identitySelector: "#account",
        identityAttribute: "data-handle",
        navigate: false
      });
      const healthy = await new BrowserSessionHealthService(store, healthyProbe).check(
        identity().identityId,
        operator.page,
        "2026-08-26T16:12:30Z",
        { type: "test", id: "healthy-dom" }
      );
      assert.equal(healthy.state, "HEALTHY");
      assert.equal(new AccountIdentityGuard(store).assertReady(identity().identityId).state, "HEALTHY");

      await operator.page.evaluate(`document.body.innerHTML = '<div id="login-marker">login</div>'`);
      const authProbe = new ConfiguredDomSessionProbe({
        probeUrl: "about:blank",
        identitySelector: "#account",
        authSelector: "#login-marker",
        navigate: false
      });
      const auth = await new BrowserSessionHealthService(store, authProbe).check(
        identity().identityId,
        operator.page,
        "2026-08-26T16:13:00Z",
        { type: "test", id: "auth-dom" }
      );
      assert.equal(auth.state, "AUTH_REQUIRED");
      assert.throws(() => new AccountIdentityGuard(store).assertReady(identity().identityId), SessionNotReadyError);
    } finally {
      await operator.close();
    }
  } finally {
    store.close();
    await new Promise((resolve) => setTimeout(resolve, 300));
    rmSync(runtimePaths.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
  }
});
