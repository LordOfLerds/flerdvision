import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteControlPlaneStore } from "../dist/adapters/storage/sqlite.js";
import { BrowserProfileDirectoryResolver, FileBrowserProfileLockAdapter } from "../dist/adapters/browser/profile-lock.js";
import { ChromiumCdpRuntimeAdapter } from "../dist/adapters/browser/chromium-cdp.js";
import { BrowserBootstrapService } from "../dist/application/browser-bootstrap.js";
import { findChromiumExecutable } from "../dist/adapters/browser/resolve-chromium.js";
import { ConfiguredChannelDiscovery } from "../dist/adapters/browser/configured-channel-discovery.js";
import { SetupChannelRegistrationService } from "../dist/application/setup-channel-registration.js";
import {
  ChannelDiscoveryError,
  UncalibratedChannelDiscoveryError,
  deriveAccountId,
  selectDiscoveredChannel
} from "../dist/domain/channel-discovery.js";
import { ChannelSourceBindingConflictError } from "../dist/domain/source-binding.js";

const REAL_CHROMIUM = findChromiumExecutable();
const ACTOR = { type: "test", id: "w9" };

function tempRuntime() {
  const dir = mkdtempSync(join(tmpdir(), "flerdvision-w9-"));
  return { dir, db: join(dir, "control.sqlite"), profiles: join(dir, "profiles") };
}

function discovery(overrides = {}) {
  return {
    platform: "youtube",
    state: "HEALTHY",
    discoveredAt: "2026-08-26T18:00:00Z",
    currentUrl: "https://www.youtube.com/account",
    channels: [
      { channelKey: "UCflerdvision", handle: "@flerdvision", displayName: "Flerdvision", detail: "1.240 Abos" },
      { channelKey: "UClucaerd", handle: "@lucaerd", displayName: "Luca Erdkönig", detail: "38 Abos" }
    ],
    ...overrides
  };
}

function calibrated(spec) {
  return [{
    specId: "test-discovery-v1",
    platform: "youtube",
    calibrationStatus: "CALIBRATED",
    calibratedAt: "2026-08-26T17:00:00Z",
    calibratedBy: "w9-test",
    spec: { platform: "youtube", ...spec }
  }];
}

/* ---------------- selection: the inversion itself ---------------- */

test("a channel absent from the discovery result cannot be selected", () => {
  assert.throws(
    () => selectDiscoveredChannel(discovery(), "UCtyped_from_memory"),
    ChannelDiscoveryError
  );
  // The two that were actually observed resolve.
  assert.equal(selectDiscoveredChannel(discovery(), "UCflerdvision").handle, "@flerdvision");
  assert.equal(selectDiscoveredChannel(discovery(), "UClucaerd").handle, "@lucaerd");
});

test("an unhealthy session yields no selectable channel regardless of what it listed", () => {
  for (const state of ["AUTH_REQUIRED", "CHALLENGE", "UNREACHABLE", "UNKNOWN", "IDENTITY_MISMATCH"]) {
    assert.throws(() => selectDiscoveredChannel(discovery({ state }), "UCflerdvision"), ChannelDiscoveryError);
  }
});

test("internal account ids are derived from the platform key, not chosen by the operator", () => {
  assert.equal(deriveAccountId("youtube", "UCflerdvision"), "youtube_ucflerdvision");
  assert.equal(deriveAccountId("instagram", "flerdvision"), "instagram_flerdvision");
  // Keys that could escape an id or a profile path are refused outright.
  for (const unsafe of ["../etc", "a b", "wat;rm", ""]) {
    assert.throws(() => deriveAccountId("instagram", unsafe), ChannelDiscoveryError);
  }
});

/* ---------------- registration ---------------- */

test("registration takes its handle from the session and records the observation as evidence", () => {
  const paths = tempRuntime();
  const store = new SqliteControlPlaneStore(paths.db);
  try {
    const service = new SetupChannelRegistrationService(store);
    const registered = service.registerFromDiscovery({
      result: discovery(),
      channelKey: "UCflerdvision",
      checkId: "check:w9:1",
      now: "2026-08-26T18:00:05Z",
      actor: ACTOR
    });

    assert.equal(registered.accountId, "youtube_ucflerdvision");
    assert.equal(registered.identityId, "browser:youtube_ucflerdvision");
    assert.equal(registered.observedHandle, "flerdvision");
    assert.equal(store.getSocialAccount("youtube_ucflerdvision").account.expectedHandle, "flerdvision");

    // The registration itself left durable proof that the handle was read, not asserted.
    const health = store.latestSessionHealth("browser:youtube_ucflerdvision");
    assert.equal(health.state, "HEALTHY");
    assert.equal(health.observedHandle, "flerdvision");
    assert.equal(health.expectedHandle, health.observedHandle);
    assert.match(health.note, /channel discovery/i);
  } finally {
    store.close();
    rmSync(paths.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
  }
});

test("picking the other channel of the same login produces a different account", () => {
  const paths = tempRuntime();
  const store = new SqliteControlPlaneStore(paths.db);
  try {
    const service = new SetupChannelRegistrationService(store);
    const result = discovery();
    const first = service.registerFromDiscovery({ result, channelKey: "UCflerdvision", checkId: "c1", now: "2026-08-26T18:00:05Z", actor: ACTOR });
    const second = service.registerFromDiscovery({ result, channelKey: "UClucaerd", checkId: "c2", now: "2026-08-26T18:00:06Z", actor: ACTOR });
    assert.notEqual(first.accountId, second.accountId);
    assert.equal(store.listSocialAccounts().length, 2);
    // This is the case a typed handle silently gets wrong: one Google login, several channels.
    assert.equal(store.getSocialAccount(second.accountId).account.expectedHandle, "lucaerd");
  } finally {
    store.close();
    rmSync(paths.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
  }
});

/* ---------------- source bindings ---------------- */

test("the retired folder/account binding is fail-closed, not merely unused", () => {
  const paths = tempRuntime();
  const store = new SqliteControlPlaneStore(paths.db);
  try {
    const service = new SetupChannelRegistrationService(store);
    const ig = service.registerFromDiscovery({
      result: { ...discovery(), platform: "instagram", channels: [{ channelKey: "flerdvision", handle: "@flerdvision", displayName: "Flerdvision" }] },
      channelKey: "flerdvision", checkId: "c1", now: "2026-08-26T18:00:05Z", actor: ACTOR
    });

    // Routing moved to SourceLane + DistributionRoute in the Product Control Center. The old
    // entry point must refuse rather than quietly write state nothing reads any more -- a
    // half-migrated workspace with orphan bindings is worse than a loud refusal.
    assert.throws(() => service.bindSource({
      accountId: ig.accountId, bindingId: "bind:ig", folderId: "1AbCdEf",
      folderPath: "Meine Ablage / Reels", interpretSubstructure: false,
      now: "2026-08-26T18:01:00Z", actor: ACTOR
    }), /LEGACY_SOURCE_BINDING_DISABLED/);

    assert.deepEqual(store.listChannelSourceBindings(), [], "a refused bind must leave no record");
    // The channel itself survives: only the folder wiring moved.
    assert.equal(store.getSocialAccount(ig.accountId).account.expectedHandle, "flerdvision");
  } finally {
    store.close();
    rmSync(paths.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
  }
});

test("the store still enforces one folder per account for any legacy row it holds", () => {
  const paths = tempRuntime();
  const store = new SqliteControlPlaneStore(paths.db);
  try {
    const service = new SetupChannelRegistrationService(store);
    const ig = service.registerFromDiscovery({
      result: { ...discovery(), platform: "instagram", channels: [{ channelKey: "one", handle: "@one", displayName: "One" }] },
      channelKey: "one", checkId: "c1", now: "2026-08-26T18:00:05Z", actor: ACTOR
    });
    const tt = service.registerFromDiscovery({
      result: { ...discovery(), platform: "tiktok", channels: [{ channelKey: "two", handle: "@two", displayName: "Two" }] },
      channelKey: "two", checkId: "c2", now: "2026-08-26T18:00:06Z", actor: ACTOR
    });
    const base = { source: "google_drive", folderId: "1AbCdEf", folderPath: "Ablage / Reels", interpretSubstructure: false, enabled: true };

    // Migration still reads these rows, so the invariants that make them interpretable must hold:
    // one folder may feed several accounts (cross-posting), one account never two folders.
    store.bindChannelSource({ ...base, bindingId: "b:ig", accountId: ig.accountId }, "2026-08-26T18:01:00Z", ACTOR);
    store.bindChannelSource({ ...base, bindingId: "b:tt", accountId: tt.accountId }, "2026-08-26T18:01:01Z", ACTOR);
    assert.equal(store.listChannelSourceBindingsForFolder("1AbCdEf").length, 2);

    assert.throws(
      () => store.bindChannelSource({ ...base, bindingId: "b:ig:2", accountId: ig.accountId, folderId: "9ZzYyXx" }, "2026-08-26T18:01:02Z", ACTOR),
      ChannelSourceBindingConflictError
    );
    for (const unsafe of ["../../etc/passwd", "a b", "id;rm -rf /", ""]) {
      assert.throws(() => store.bindChannelSource({ ...base, bindingId: "b:x", accountId: tt.accountId, folderId: unsafe }, "2026-08-26T18:01:03Z", ACTOR),
        /Unsafe source folder id|cannot be empty/);
    }
    assert.throws(
      () => store.bindChannelSource({ ...base, bindingId: "b:ghost", accountId: "instagram_ghost" }, "2026-08-26T18:01:04Z", ACTOR),
      ChannelSourceBindingConflictError
    );
  } finally {
    store.close();
    rmSync(paths.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
  }
});

/* ---------------- calibration gate ---------------- */

test("an uncalibrated discovery spec refuses to run instead of guessing at markup", async () => {
  const uncalibrated = new ConfiguredChannelDiscovery([{
    specId: "youtube-channel-discovery-v1",
    platform: "youtube",
    calibrationStatus: "UNVERIFIED",
    spec: { platform: "youtube", probeUrl: "about:blank", channelItemSelector: "__CALIBRATE__", channelKeyAttribute: "__CALIBRATE__", handleSelector: "__CALIBRATE__" }
  }]);
  await assert.rejects(() => uncalibrated.discover({}, "youtube", "2026-08-26T18:00:00Z"), UncalibratedChannelDiscoveryError);
});

test("a spec marked calibrated but still holding a placeholder is refused", async () => {
  const lying = new ConfiguredChannelDiscovery(calibrated({
    probeUrl: "about:blank", channelItemSelector: ".channel", channelKeyAttribute: "data-key", handleSelector: "__CALIBRATE__"
  }));
  await assert.rejects(() => lying.discover({}, "youtube", "2026-08-26T18:00:00Z"), UncalibratedChannelDiscoveryError);
});

test("a platform without a spec is refused rather than defaulted", async () => {
  const empty = new ConfiguredChannelDiscovery([]);
  await assert.rejects(() => empty.discover({}, "instagram", "2026-08-26T18:00:00Z"), ChannelDiscoveryError);
});

test("the shipped example config is uncalibrated and carries no invented selectors", async () => {
  const { readFileSync } = await import("node:fs");
  const config = JSON.parse(readFileSync(new URL("../config/channel-discovery.example.json", import.meta.url).pathname, "utf8"));
  assert.equal(config.specs.length, 3);
  for (const entry of config.specs) {
    assert.equal(entry.calibrationStatus, "UNVERIFIED");
    assert.equal(entry.spec.channelItemSelector, "__CALIBRATE__");
    assert.equal(entry.spec.handleSelector, "__CALIBRATE__");
  }
});

/* ---------------- real browser ---------------- */

test("real Chromium discovery reads several channels out of one session", { skip: REAL_CHROMIUM === undefined, timeout: 45_000 }, async () => {
  const paths = tempRuntime();
  const store = new SqliteControlPlaneStore(paths.db);
  store.registerSocialAccount({ accountId: "seed", platform: "youtube", expectedHandle: "@seed", enabled: true }, "2026-08-26T17:00:00Z", ACTOR);
  store.registerBrowserIdentity({ identityId: "browser:seed", accountId: "seed", platform: "youtube", profileKey: "youtube/seed", expectedHandle: "seed", enabled: true }, "2026-08-26T17:00:01Z", ACTOR);
  const resolver = new BrowserProfileDirectoryResolver(paths.profiles);
  const bootstrap = new BrowserBootstrapService(
    store,
    new ChromiumCdpRuntimeAdapter({ profilesRoot: paths.profiles }),
    new FileBrowserProfileLockAdapter(resolver)
  );
  try {
    const operator = await bootstrap.openForOperator({
      identityId: "browser:seed", ownerId: "w9", bootstrapUrl: "about:blank",
      now: "2026-08-26T18:00:00Z", headless: true
    });
    try {
      await operator.page.evaluate(`document.body.innerHTML = \`
        <div class="ch" data-key="UCflerdvision"><span class="h">@flerdvision</span><span class="n">Flerdvision</span><span class="d">1.240 Abos</span></div>
        <div class="ch" data-key="UClucaerd"><span class="h">@lucaerd</span><span class="n">Luca Erdkoenig</span><span class="d">38 Abos</span></div>\``);

      const found = await new ConfiguredChannelDiscovery(calibrated({
        probeUrl: "about:blank", navigate: false,
        channelItemSelector: ".ch", channelKeyAttribute: "data-key",
        handleSelector: ".h", displayNameSelector: ".n", detailSelector: ".d"
      })).discover(operator.page, "youtube", "2026-08-26T18:00:10Z");

      assert.equal(found.state, "HEALTHY");
      assert.equal(found.channels.length, 2);
      assert.deepEqual(found.channels.map((c) => c.channelKey), ["UCflerdvision", "UClucaerd"]);
      assert.equal(found.channels[1].detail, "38 Abos");

      // End to end: what the browser reported is what gets stored.
      const registered = new SetupChannelRegistrationService(store).registerFromDiscovery({
        result: found, channelKey: "UClucaerd", checkId: "check:real", now: "2026-08-26T18:00:11Z", actor: ACTOR
      });
      assert.equal(registered.accountId, "youtube_uclucaerd");
      assert.equal(store.getSocialAccount("youtube_uclucaerd").account.expectedHandle, "lucaerd");

      // An authentication marker suppresses the channel list rather than returning half of it.
      await operator.page.evaluate(`document.body.innerHTML = '<div id="signin">Sign in</div>'`);
      const gated = await new ConfiguredChannelDiscovery(calibrated({
        probeUrl: "about:blank", navigate: false, authSelector: "#signin",
        channelItemSelector: ".ch", channelKeyAttribute: "data-key", handleSelector: ".h"
      })).discover(operator.page, "youtube", "2026-08-26T18:00:20Z");
      assert.equal(gated.state, "AUTH_REQUIRED");
      assert.deepEqual(gated.channels, []);
      assert.throws(() => selectDiscoveredChannel(gated, "UCflerdvision"), ChannelDiscoveryError);
    } finally {
      await operator.close();
    }
  } finally {
    store.close();
    rmSync(paths.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
  }
});
