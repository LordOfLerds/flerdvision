import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ChromiumCdpRuntimeAdapter } from "../dist/adapters/browser/chromium-cdp.js";
import { BrowserProfileDirectoryResolver, FileBrowserProfileLockAdapter } from "../dist/adapters/browser/profile-lock.js";
import { LocalPrepareArtifactSink } from "../dist/adapters/browser/prepare-artifacts.js";
import {
  DeclarativePlatformUiAdapter,
  InstagramWebPrepareAdapter,
  TikTokWebPrepareAdapter,
  YouTubeStudioPrepareAdapter
} from "../dist/adapters/publish/declarative-platform-ui.js";
import {
  GoogleDriveRestMediaMaterializer,
  LocalFileMediaMaterializer,
  MediaMaterializationError
} from "../dist/adapters/publish/media-materializer.js";
import { StaticPublicationPayloadResolver } from "../dist/adapters/publish/payload-resolver.js";
import { PrepareOnlyFinalActionError, PrepareOnlyPlatformPublisher } from "../dist/application/prepare-only-publisher.js";
import { SqliteControlPlaneStore } from "../dist/adapters/storage/sqlite.js";
import { writeMigrationOneDatabase } from "./fixtures/make-w1-fixture.mjs";

function tempRuntime() {
  const dir = mkdtempSync(join(tmpdir(), "flerdvision-w4-"));
  const profiles = join(dir, "profiles");
  const media = join(dir, "media");
  const evidence = join(dir, "evidence");
  mkdirSync(profiles, { recursive: true });
  mkdirSync(media, { recursive: true });
  mkdirSync(evidence, { recursive: true });
  return { dir, db: join(dir, "flerdvision.sqlite"), profiles, media, evidence };
}

function account(platform = "instagram") {
  return { accountId: `acct:${platform}`, creatorId: "creator:test", platform, expectedHandle: `${platform}_test`, enabled: true };
}
function identity(platform = "instagram") {
  return {
    identityId: `browser:${platform}`, accountId: `acct:${platform}`, platform,
    profileKey: `${platform}/test`, expectedHandle: `${platform}_test`, enabled: true
  };
}
function intent(platform = "instagram", format = "reel") {
  return {
    intentId: `intent:${platform}:${format}`, contentId: "content:test", creatorId: "creator:test",
    platform, accountId: `acct:${platform}`, format, copyVersionId: `copy:${platform}`,
    scheduledFor: "2026-08-27T07:00:00Z", idempotencyKey: `idem:${platform}:${format}`
  };
}

function spec(platform, format) {
  const capability = platform === "instagram" ? (format === "trial_reel" ? "trial_reel" : "reel") : platform === "tiktok" ? "tiktok_video" : "youtube_short";
  const fieldCapability = platform === "youtube" ? "title" : "caption";
  const fieldValue = platform === "youtube" ? "title" : "caption";
  return {
    platform,
    bootstrapUrl: "about:blank",
    supportedFormats: [format],
    requiredCapabilities: { [format]: ["web_video_upload", capability, fieldCapability, "final_action_boundary"] },
    capabilityLocators: {
      web_video_upload: [{ kind: "css", value: "#media" }],
      [capability]: [{ kind: "css", value: "#format" }],
      [fieldCapability]: [{ kind: "css", value: "#copy" }]
    },
    preUploadActions: [],
    uploadActions: [{ action: "set_file", locators: [{ kind: "css", value: "#media" }], valueFrom: "media", label: "media-upload" }],
    fieldActions: [{ action: "fill", locators: [{ kind: "css", value: "#copy" }], valueFrom: fieldValue, label: "copy-field" }],
    formatActions: format === "trial_reel" ? {
      [format]: [{ action: "click", locators: [{ kind: "css", value: "#format" }], label: "trial-toggle" }]
    } : {},
    finalActionBoundary: [{ kind: "role", role: "button", value: platform === "youtube" ? "Publish" : "Share", exact: true }]
  };
}

function fixtureHtml(platform, format) {
  const label = platform === "youtube" ? "Publish" : "Share";
  const trial = format === "trial_reel" ? `onclick="this.dataset.selected='yes'"` : "";
  return `<main>
    <input id="media" type="file" />
    <textarea id="copy"></textarea>
    <button id="format" ${trial}>Format</button>
    <button id="final" aria-label="${label}" onclick="this.dataset.clicked='yes'">${label}</button>
  </main>`;
}

function wrapFixture(page, html) {
  return {
    identityId: page.identityId,
    profileDirectory: page.profileDirectory,
    async navigate(url) { await page.navigate(url); await page.evaluate(`document.body.innerHTML = ${JSON.stringify(html)}`); },
    currentUrl: () => page.currentUrl(),
    evaluate: (expression) => page.evaluate(expression),
    setInputFiles: (selector, paths) => page.setInputFiles(selector, paths),
    captureScreenshot: (path) => page.captureScreenshot(path),
    setCookie: (url, name, value, expires) => page.setCookie(url, name, value, expires),
    cookies: (url) => page.cookies(url),
    close: () => page.close()
  };
}

async function openFixture(runtimePaths, platform, format, html = fixtureHtml(platform, format)) {
  const chromium = new ChromiumCdpRuntimeAdapter({ profilesRoot: runtimePaths.profiles });
  const page = await chromium.launch(identity(platform), { headless: true, initialUrl: "about:blank" });
  return wrapFixture(page, html);
}

function createMedia(runtimePaths, name = "test-video.mp4", bytes = "not-a-real-video-but-stable-test-bytes") {
  const path = join(runtimePaths.media, name);
  writeFileSync(path, bytes);
  return path;
}

function registerAccount(store, platform = "instagram") {
  store.registerSocialAccount(account(platform), "2026-08-26T16:00:00Z", { type: "test", id: "acct" });
  store.registerBrowserIdentity(identity(platform), "2026-08-26T16:00:01Z", { type: "test", id: "identity" });
}

function insertContent(store, mediaPath) {
  const observation = {
    observationId: "source:test", sourceId: "fixture", externalObjectId: "media:test",
    observedAt: "2026-08-26T16:00:00Z", locator: `file://${mediaPath}`, mediaFingerprint: "fixture:v1", metadata: { fileName: "test-video.mp4" }
  };
  store.observeOrGetSource(observation, "2026-08-26T16:00:00Z", { type: "test", id: "source" });
  store.createOrGetContent({
    contentId: "content:test", acceptedFromObservationId: "source:test", creatorId: "creator:test",
    mediaFingerprint: "fixture:v1", immutableMediaRef: `file://${mediaPath}`, metadata: { fileName: "test-video.mp4" }
  }, "2026-08-26T16:00:02Z", { type: "test", id: "content" });
  store.decideSourceObservation("source:test", "ACCEPTED", "2026-08-26T16:00:03Z", { type: "test", id: "accept" }, { contentId: "content:test" });
}

test("migration 4 persists append-only per-account capability probes", () => {
  const runtimePaths = tempRuntime();
  const store = new SqliteControlPlaneStore(runtimePaths.db);
  try {
    registerAccount(store, "instagram");
    const first = store.recordCapabilityProbe({
      probeId: "cap:1", accountId: "acct:instagram", identityId: "browser:instagram", platform: "instagram",
      probedAt: "2026-08-26T16:05:00Z", capabilities: { web_video_upload: "AVAILABLE", trial_reel: "UNKNOWN" }
    }, { type: "test", id: "probe" });
    assert.equal(first.capabilities.web_video_upload, "AVAILABLE");
    const second = store.recordCapabilityProbe({
      probeId: "cap:2", accountId: "acct:instagram", identityId: "browser:instagram", platform: "instagram",
      probedAt: "2026-08-26T16:06:00Z", capabilities: { web_video_upload: "AVAILABLE", trial_reel: "AVAILABLE" }
    }, { type: "test", id: "probe" });
    assert.equal(store.latestCapabilityProbe("acct:instagram")?.probeId, second.probeId);
    assert.equal(store.listCapabilityProbes("acct:instagram").length, 2);
  } finally { store.close(); }
  const raw = new DatabaseSync(runtimePaths.db);
  try {
    assert.throws(() => raw.exec("UPDATE platform_capability_probes SET note = 'rewrite'"), /append-only/);
    assert.throws(() => raw.exec("DELETE FROM platform_capability_probes"), /append-only/);
  } finally { raw.close(); rmSync(runtimePaths.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }); }
});

test("local media materializer hashes exact bytes and rejects paths outside allowed root", async () => {
  const runtimePaths = tempRuntime();
  try {
    const mediaPath = createMedia(runtimePaths);
    const materializer = new LocalFileMediaMaterializer({ allowedRoot: runtimePaths.media });
    const artifact = await materializer.materialize({
      contentId: "content:test", acceptedFromObservationId: "source:test", creatorId: "creator:test",
      mediaFingerprint: "fixture", immutableMediaRef: `file://${mediaPath}`, metadata: {}
    });
    assert.equal(artifact.sizeBytes, statSync(mediaPath).size);
    assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
    await assert.rejects(() => materializer.materialize({
      contentId: "content:bad", acceptedFromObservationId: "source:bad", creatorId: "creator:test",
      mediaFingerprint: "fixture", immutableMediaRef: "file:///etc/passwd", metadata: {}
    }), MediaMaterializationError);
  } finally { rmSync(runtimePaths.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }); }
});

test("Google Drive media materializer streams authenticated bytes into controlled cache", async () => {
  const runtimePaths = tempRuntime();
  const previousFetch = globalThis.fetch;
  let seenUrl = "";
  let seenAuth = "";
  globalThis.fetch = async (url, init) => {
    seenUrl = String(url);
    seenAuth = String(init?.headers?.Authorization ?? "");
    return new Response(new TextEncoder().encode("drive-media-bytes"), { status: 200 });
  };
  try {
    const materializer = new GoogleDriveRestMediaMaterializer({ async getAccessToken() { return "drive-token"; } }, { cacheRoot: runtimePaths.media, baseUrl: "https://drive.test/v3" });
    const artifact = await materializer.materialize({
      contentId: "content:test", acceptedFromObservationId: "source:test", creatorId: "creator:test",
      mediaFingerprint: "drive:v1", immutableMediaRef: "gdrive://file/file-123", metadata: { fileName: "clip.mp4" }
    });
    assert.equal(readFileSync(artifact.localPath, "utf8"), "drive-media-bytes");
    assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
    assert.match(seenUrl, /files\/file-123\?alt=media/);
    assert.equal(seenAuth, "Bearer drive-token");
    await materializer.release(artifact);
  } finally {
    globalThis.fetch = previousFetch;
    rmSync(runtimePaths.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
  }
});

for (const [platform, format, Adapter] of [
  ["instagram", "reel", InstagramWebPrepareAdapter],
  ["instagram", "trial_reel", InstagramWebPrepareAdapter],
  ["tiktok", "tiktok", TikTokWebPrepareAdapter],
  ["youtube", "short", YouTubeStudioPrepareAdapter]
]) {
  test(`${platform} ${format} prepare reaches final boundary without clicking it`, { timeout: 45_000 }, async () => {
    const runtimePaths = tempRuntime();
    const mediaPath = createMedia(runtimePaths, `${platform}.mp4`, `bytes-${platform}-${format}`);
    const page = await openFixture(runtimePaths, platform, format);
    try {
      const adapter = new Adapter(spec(platform, format));
      const materializer = new LocalFileMediaMaterializer({ allowedRoot: runtimePaths.media });
      const media = await materializer.materialize({
        contentId: "content:test", acceptedFromObservationId: "source:test", creatorId: "creator:test",
        mediaFingerprint: "fixture", immutableMediaRef: `file://${mediaPath}`, metadata: {}
      });
      const payload = platform === "youtube"
        ? { copyVersionId: `copy:${platform}`, title: "Private test short" }
        : { copyVersionId: `copy:${platform}`, caption: "Private test caption" };
      let tick = 0;
      const result = await adapter.prepare(page, identity(platform), intent(platform, format), media, payload, new LocalPrepareArtifactSink(runtimePaths.evidence), () => `2026-08-26T16:10:${String(tick++).padStart(2, "0")}Z`);
      assert.equal(result.reachedFinalActionBoundary, true);
      assert.equal(await page.evaluate("document.querySelector('#final').dataset.clicked || null"), null);
      assert.equal(await page.evaluate("document.querySelector('#copy').value"), platform === "youtube" ? "Private test short" : "Private test caption");
      assert.equal(await page.evaluate("document.querySelector('#media').files[0].name"), `${platform}.mp4`);
      if (format === "trial_reel") assert.equal(await page.evaluate("document.querySelector('#format').dataset.selected"), "yes");
      const probe = await adapter.probeCapabilities(page, identity(platform), intent(platform, format), "2026-08-26T16:11:00Z");
      assert.equal(probe.capabilities.web_video_upload, "AVAILABLE");
      assert.equal(probe.capabilities.final_action_boundary, "AVAILABLE");
      assert.ok(result.artifactRefs.some((path) => path.endsWith(".png")));
      assert.ok(result.artifactRefs.some((path) => path.endsWith(".html")));
      assert.ok(result.artifactRefs.some((path) => path.includes("action-journal")));
    } finally {
      await page.close();
      await new Promise((resolve) => setTimeout(resolve, 200));
      rmSync(runtimePaths.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
    }
  });
}

test("prepare-only publisher integrates fresh identity check, media, copy, capability audit and never implements final action", { timeout: 45_000 }, async () => {
  const runtimePaths = tempRuntime();
  const store = new SqliteControlPlaneStore(runtimePaths.db);
  const mediaPath = createMedia(runtimePaths, "publisher.mp4", "publisher-exact-bytes");
  try {
    registerAccount(store, "instagram");
    insertContent(store, mediaPath);
    const baseRuntime = new ChromiumCdpRuntimeAdapter({ profilesRoot: runtimePaths.profiles });
    const wrappedRuntime = {
      async launch(browserIdentity, options) {
        const page = await baseRuntime.launch(browserIdentity, options);
        return wrapFixture(page, fixtureHtml("instagram", "reel"));
      }
    };
    const publisher = new PrepareOnlyPlatformPublisher(
      store,
      wrappedRuntime,
      new FileBrowserProfileLockAdapter(new BrowserProfileDirectoryResolver(runtimePaths.profiles)),
      {
        instagram: { async probe() { return { state: "HEALTHY", observedHandle: "instagram_test", currentUrl: "about:blank" }; } },
        tiktok: { async probe() { return { state: "HEALTHY", observedHandle: "tiktok_test", currentUrl: "about:blank" }; } },
        youtube: { async probe() { return { state: "HEALTHY", observedHandle: "youtube_test", currentUrl: "about:blank" }; } }
      },
      new StaticPublicationPayloadResolver([{ copyVersionId: "copy:instagram", caption: "Prepare-only caption" }]),
      new LocalFileMediaMaterializer({ allowedRoot: runtimePaths.media }),
      new LocalPrepareArtifactSink(runtimePaths.evidence),
      [new InstagramWebPrepareAdapter(spec("instagram", "reel"))],
      { releaseSha: "w4-test", ownerId: "w4-worker", headless: true, now: (() => { let i = 0; return () => `2026-08-26T16:20:${String(i++).padStart(2, "0")}Z`; })() }
    );
    const prepared = await publisher.prepare(intent("instagram", "reel"));
    assert.equal(prepared.result, "prepared");
    assert.equal(prepared.reachedFinalActionBoundary, true);
    assert.match(prepared.mediaSha256, /^[a-f0-9]{64}$/);
    assert.equal(store.latestSessionHealth("browser:instagram")?.state, "HEALTHY");
    assert.equal(store.latestCapabilityProbe("acct:instagram")?.capabilities.final_action_boundary, "AVAILABLE");
    await assert.rejects(
      () => publisher.invokeFinalAction(intent("instagram", "reel"), prepared, {
        mode: "production", allowFinalPublish: true, allowedAccountIds: new Set(["acct:instagram"]), releaseSha: "w4-test"
      }),
      PrepareOnlyFinalActionError
    );
  } finally {
    store.close();
    await new Promise((resolve) => setTimeout(resolve, 300));
    rmSync(runtimePaths.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
  }
});

test("prepare kernel refuses a configured click when it resolves to the final-action element", { timeout: 45_000 }, async () => {
  const runtimePaths = tempRuntime();
  const mediaPath = createMedia(runtimePaths, "guard.mp4", "guard-bytes");
  const page = await openFixture(runtimePaths, "instagram", "reel");
  try {
    const unsafe = spec("instagram", "reel");
    unsafe.preUploadActions = [{
      action: "click",
      locators: [{ kind: "text", value: "Share", exact: true }],
      label: "misconfigured-final-click"
    }];
    const adapter = new DeclarativePlatformUiAdapter(unsafe);
    const media = await new LocalFileMediaMaterializer({ allowedRoot: runtimePaths.media }).materialize({
      contentId: "content:test", acceptedFromObservationId: "source:test", creatorId: "creator:test",
      mediaFingerprint: "fixture", immutableMediaRef: `file://${mediaPath}`, metadata: {}
    });
    await assert.rejects(
      () => adapter.prepare(
        page,
        identity("instagram"),
        intent("instagram", "reel"),
        media,
        { copyVersionId: "copy:instagram", caption: "Guard caption" },
        new LocalPrepareArtifactSink(runtimePaths.evidence),
        () => "2026-08-26T16:30:00Z"
      ),
      /Refusing to click the final-action boundary/
    );
    assert.equal(await page.evaluate("document.querySelector('#final').dataset.clicked || null"), null);
  } finally {
    await page.close();
    await new Promise((resolve) => setTimeout(resolve, 200));
    rmSync(runtimePaths.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
  }
});

test("platform UI config refuses uncalibrated or placeholder specs before real execution", async () => {
  const { parsePlatformUiSpecFile } = await import("../dist/adapters/publish/platform-spec-config.js");
  const unverified = {
    schemaVersion: 1,
    specs: [{
      specId: "instagram-web-v1", platform: "instagram", calibrationStatus: "UNVERIFIED",
      spec: spec("instagram", "reel")
    }]
  };
  assert.throws(() => parsePlatformUiSpecFile(unverified, true), /not calibrated/);

  const calibrated = structuredClone(unverified);
  calibrated.specs[0].calibrationStatus = "CALIBRATED";
  calibrated.specs[0].calibratedAt = "2026-08-26T16:40:00Z";
  calibrated.specs[0].calibratedBy = "operator:test";
  calibrated.specs[0].spec.bootstrapUrl = "https://example.invalid/";
  assert.equal(parsePlatformUiSpecFile(calibrated, true).specs[0].spec.platform, "instagram");

  calibrated.specs[0].spec.finalActionBoundary = [{ kind: "css", value: "__CALIBRATE__" }];
  assert.throws(() => parsePlatformUiSpecFile(calibrated, true), /calibration placeholder/);
});


test("existing W1 database migrates through W4 capability storage without losing durable state", () => {
  const dir = mkdtempSync(join(tmpdir(), "flerdvision-w4-upgrade-"));
  const copied = writeMigrationOneDatabase(join(dir, "upgrade.sqlite"));
  const store = new SqliteControlPlaneStore(copied);
  try {
    assert.ok(store.summary("2026-08-26T18:00:00Z"));
    assert.deepEqual(store.listCapabilityProbes(), []);
    registerAccount(store, "instagram");
    store.recordCapabilityProbe({
      probeId: "cap:upgrade", accountId: "acct:instagram", identityId: "browser:instagram", platform: "instagram",
      probedAt: "2026-08-26T18:01:00Z", capabilities: { web_video_upload: "UNKNOWN" }
    }, { type: "test", id: "upgrade" });
    assert.equal(store.latestCapabilityProbe("acct:instagram")?.probeId, "cap:upgrade");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
  }
});

test("unverified example platform config is loadable only in relaxed calibration mode", async () => {
  const { loadPlatformUiSpecFile } = await import("../dist/adapters/publish/platform-spec-config.js");
  const config = loadPlatformUiSpecFile(new URL("../config/platform-ui.example.json", import.meta.url).pathname, false);
  assert.equal(config.specs.length, 3);
  assert.ok(config.specs.every((entry) => entry.calibrationStatus === "UNVERIFIED"));
  assert.throws(
    () => loadPlatformUiSpecFile(new URL("../config/platform-ui.example.json", import.meta.url).pathname, true),
    /not calibrated/
  );
});
