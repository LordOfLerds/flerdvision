import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteControlPlaneStore, E2EPermitConflictError } from "../dist/adapters/storage/sqlite.js";
import { PrivateE2ERunService, E2EPublishPermitService, PrivateE2EPolicyError } from "../dist/application/private-e2e.js";
import { NodeHostPreflightAdapter } from "../dist/adapters/e2e/host-preflight.js";
import { aiProviderPreflight } from "../dist/application/ai-provider.js";
import { ChromiumCdpRuntimeAdapter } from "../dist/adapters/browser/chromium-cdp.js";
import { BrowserProfileDirectoryResolver, FileBrowserProfileLockAdapter } from "../dist/adapters/browser/profile-lock.js";
import { LocalPrepareArtifactSink } from "../dist/adapters/browser/prepare-artifacts.js";
import { InstagramWebPrepareAdapter } from "../dist/adapters/publish/declarative-platform-ui.js";
import { LocalFileMediaMaterializer } from "../dist/adapters/publish/media-materializer.js";
import { StaticPublicationPayloadResolver } from "../dist/adapters/publish/payload-resolver.js";
import { PlatformPreparationCoordinator } from "../dist/application/platform-preparation.js";
import { LiveE2EPreparationService, PrivateE2EFinalActionController, RetainedPreparedSessionRegistry, RetainedSessionFinalActionInvoker } from "../dist/application/private-e2e-live-publisher.js";
import { resolveChromiumExecutablePath } from "../dist/adapters/browser/resolve-chromium.js";

const actor = { type: "test", id: "w8" };

function tempRuntime() {
  const dir = mkdtempSync(join(tmpdir(), "flerdvision-w8-"));
  const profiles = join(dir, "profiles"); const media = join(dir, "media"); const evidence = join(dir, "evidence"); const runtime = join(dir, "runtime");
  for (const p of [profiles, media, evidence, runtime]) { mkdirSync(p, { recursive: true, mode: 0o700 }); chmodSync(p, 0o700); }
  return { dir, db: join(runtime, "flerdvision.sqlite"), profiles, media, evidence, runtime };
}

function account() { return { accountId: "acct:test-instagram", creatorId: "creator:test", platform: "instagram", expectedHandle: "private_test", enabled: true }; }
function identity() { return { identityId: "browser:test-instagram", accountId: "acct:test-instagram", platform: "instagram", profileKey: "instagram/private-test", expectedHandle: "private_test", enabled: true }; }
function intent() { return { intentId: "intent:w8", contentId: "content:w8", creatorId: "creator:test", platform: "instagram", accountId: "acct:test-instagram", format: "reel", copyVersionId: "copy:w8", scheduledFor: "2026-08-27T07:00:00Z", idempotencyKey: "idem:w8" }; }

function uiSpec() {
  return {
    platform: "instagram", bootstrapUrl: "about:blank", supportedFormats: ["reel"],
    requiredCapabilities: { reel: ["web_video_upload", "reel", "caption", "final_action_boundary"] },
    capabilityLocators: {
      web_video_upload: [{ kind: "css", value: "#media" }], reel: [{ kind: "css", value: "#format" }], caption: [{ kind: "css", value: "#caption" }]
    },
    preUploadActions: [],
    uploadActions: [{ action: "set_file", locators: [{ kind: "css", value: "#media" }], valueFrom: "media", label: "media" }],
    fieldActions: [{ action: "fill", locators: [{ kind: "css", value: "#caption" }], valueFrom: "caption", label: "caption" }],
    formatActions: {},
    finalActionBoundary: [{ kind: "role", role: "button", value: "Share", exact: true }]
  };
}

function html() {
  return `<div id="who">private_test</div><input id="media" type="file"><textarea id="caption"></textarea><button id="format">Reel</button><button id="final" aria-label="Share" onclick="this.dataset.clicked='yes'">Share</button>`;
}

function wrapFixture(page) {
  const inject = () => page.evaluate(`document.body.innerHTML = ${JSON.stringify(html())}`);
  return {
    identityId: page.identityId, profileDirectory: page.profileDirectory,
    async navigate(url) { await page.navigate(url); await inject(); },
    currentUrl: () => page.currentUrl(), evaluate: (expr) => page.evaluate(expr), setInputFiles: (sel, paths) => page.setInputFiles(sel, paths),
    captureScreenshot: (path) => page.captureScreenshot(path), setCookie: (url, name, value, expires) => page.setCookie(url, name, value, expires),
    cookies: (url) => page.cookies(url), close: () => page.close()
  };
}

function bootstrapStore(paths) {
  const store = new SqliteControlPlaneStore(paths.db);
  store.registerSocialAccount(account(), "2026-08-26T16:00:00Z", actor);
  store.registerBrowserIdentity(identity(), "2026-08-26T16:00:01Z", actor);
  const mediaPath = join(paths.media, "private-test.mp4"); writeFileSync(mediaPath, "private-e2e-test-bytes");
  store.observeOrGetSource({ observationId: "source:w8", sourceId: "fixture", externalObjectId: "file:w8", observedAt: "2026-08-26T16:00:02Z", locator: `file://${mediaPath}`, mediaFingerprint: "w8:v1", metadata: { fileName: "private-test.mp4" } }, "2026-08-26T16:00:02Z", actor);
  store.createOrGetContent({ contentId: "content:w8", acceptedFromObservationId: "source:w8", creatorId: "creator:test", mediaFingerprint: "w8:v1", immutableMediaRef: `file://${mediaPath}`, metadata: { fileName: "private-test.mp4", purpose: "private_e2e" } }, "2026-08-26T16:00:03Z", actor);
  store.decideSourceObservation("source:w8", "ACCEPTED", "2026-08-26T16:00:04Z", actor, { contentId: "content:w8" });
  store.createOrGetIntent(intent(), "2026-08-26T16:00:05Z", actor);
  store.transitionIntent("intent:w8", "READY", "2026-08-26T16:00:06Z", actor);
  store.transitionIntent("intent:w8", "SCHEDULED", "2026-08-26T16:00:07Z", actor);
  return { store, mediaPath };
}

function passRequiredGates(service, runId) {
  const gates = ["HOST_PREFLIGHT", "SESSION_HEALTH", "IDENTITY_GUARD", "UI_CALIBRATION", "FINAL_ACTION_CALIBRATION"];
  let i = 0;
  for (const gate of gates) service.recordGate({ runId, gate, status: "PASS", checkedAt: `2026-08-26T16:10:${String(i++).padStart(2,"0")}Z`, checkedBy: "operator", summary: `${gate} passed`, artifactRefs: [], details: {} }, actor);
  for (let n = 0; n < 3; n++) service.recordGate({ runId, gate: "PREPARE_ONLY_REPLAY", status: "PASS", checkedAt: `2026-08-26T16:11:0${n}Z`, checkedBy: "operator", summary: `prepare replay ${n + 1}`, artifactRefs: [], details: { replay: n + 1 } }, actor);
}

test("migration 8 stores append-only E2E gates and one-shot permits", () => {
  const paths = tempRuntime(); const { store } = bootstrapStore(paths);
  try {
    const service = new PrivateE2ERunService(store);
    service.start({ runId: "e2e:w8", accountId: account().accountId, platform: "instagram", releaseSha: "sha-w8", now: "2026-08-26T16:10:00Z", operatorId: "operator" }, actor);
    service.recordGate({ runId: "e2e:w8", gate: "HOST_PREFLIGHT", status: "PASS", checkedAt: "2026-08-26T16:10:01Z", checkedBy: "operator", summary: "ok", artifactRefs: [], details: {} }, actor);
    assert.equal(store.listE2EGateResults("e2e:w8").length, 1);
  } finally { store.close(); }
  const raw = new DatabaseSync(paths.db);
  try {
    assert.throws(() => raw.exec("UPDATE e2e_gate_results SET summary='rewrite'"), /append-only/);
    assert.throws(() => raw.exec("DELETE FROM e2e_gate_results"), /append-only/);
  } finally { raw.close(); rmSync(paths.dir, { recursive: true, force: true }); }
});

test("zero-viewer privacy attestation fails closed", () => {
  const paths = tempRuntime(); const { store } = bootstrapStore(paths);
  try {
    const service = new PrivateE2ERunService(store);
    service.start({ runId: "e2e:privacy", accountId: account().accountId, platform: "instagram", releaseSha: "sha-w8", now: "2026-08-26T16:10:00Z", operatorId: "operator" }, actor);
    assert.throws(() => service.attestPrivacy("e2e:privacy", { accountPrivate: true, approvedFollowers: 1, contactsSyncOff: true, crossPostingOff: true, testMediaOnly: true }, "2026-08-26T16:10:01Z", "operator", actor), PrivateE2EPolicyError);
    assert.equal(store.listE2EGateResults("e2e:privacy").at(-1).status, "FAIL");
  } finally { store.close(); rmSync(paths.dir, { recursive: true, force: true }); }
});

test("E2E permit requires all gates, is short-lived and one-shot", () => {
  const paths = tempRuntime(); const { store } = bootstrapStore(paths);
  try {
    const service = new PrivateE2ERunService(store); const permits = new E2EPublishPermitService(store);
    service.start({ runId: "e2e:permit", accountId: account().accountId, platform: "instagram", releaseSha: "sha-w8", now: "2026-08-26T16:10:00Z", operatorId: "operator" }, actor);
    passRequiredGates(service, "e2e:permit");
    service.attestPrivacy("e2e:permit", { accountPrivate: true, approvedFollowers: 0, contactsSyncOff: true, crossPostingOff: true, testMediaOnly: true }, "2026-08-26T16:12:00Z", "operator", actor);
    const context = { mode: "test_account", allowFinalPublish: true, allowedAccountIds: new Set([account().accountId]), releaseSha: "sha-w8" };
    const issued = permits.issue({ runId: "e2e:permit", intent: intent(), context, now: "2026-08-26T16:13:00Z", operatorId: "operator", ttlSeconds: 60 }, actor);
    permits.consume({ permitId: issued.permit.permitId, token: issued.token, runId: "e2e:permit", intent: intent(), context, now: "2026-08-26T16:13:10Z", workerId: "worker" }, actor);
    assert.throws(() => permits.consume({ permitId: issued.permit.permitId, token: issued.token, runId: "e2e:permit", intent: intent(), context, now: "2026-08-26T16:13:11Z", workerId: "worker" }, actor), E2EPermitConflictError);
  } finally { store.close(); rmSync(paths.dir, { recursive: true, force: true }); }
});

test("retained prepared session crosses durable boundary and invokes final click exactly once", { timeout: 45_000 }, async () => {
  const paths = tempRuntime(); const { store } = bootstrapStore(paths);
  const baseRuntime = new ChromiumCdpRuntimeAdapter({ profilesRoot: paths.profiles });
  const runtime = { async launch(browserIdentity, options) { const page = await baseRuntime.launch(browserIdentity, options); const wrapped = wrapFixture(page); await wrapped.evaluate(`document.body.innerHTML = ${JSON.stringify(html())}`); return wrapped; } };
  const probe = { async probe(page) { return { state: "HEALTHY", observedHandle: "private_test", currentUrl: await page.currentUrl() }; } };
  const adapter = new InstagramWebPrepareAdapter(uiSpec());
  const coordinator = new PlatformPreparationCoordinator(
    store, runtime, new FileBrowserProfileLockAdapter(new BrowserProfileDirectoryResolver(paths.profiles)),
    { instagram: probe, tiktok: probe, youtube: probe }, new StaticPublicationPayloadResolver([{ copyVersionId: "copy:w8", caption: "PRIVATE E2E TEST" }]),
    new LocalFileMediaMaterializer({ allowedRoot: paths.media }), new LocalPrepareArtifactSink(paths.evidence), [adapter],
    { releaseSha: "sha-w8", ownerId: "worker", headless: true, now: (() => { let i=0; return () => `2026-08-26T16:20:${String(i++).padStart(2,"0")}Z`; })() }
  );
  const registry = new RetainedPreparedSessionRegistry();
  try {
    const prep = new LiveE2EPreparationService(store, coordinator, registry);
    const attempt = await prep.prepare("intent:w8", "2026-08-26T16:20:00Z", actor);
    assert.equal(store.getIntent("intent:w8").state, "PREPARING");
    assert.equal(attempt.result, "prepared");

    const runService = new PrivateE2ERunService(store); const permitService = new E2EPublishPermitService(store);
    runService.start({ runId: "e2e:live", accountId: account().accountId, platform: "instagram", releaseSha: "sha-w8", now: "2026-08-26T16:21:00Z", operatorId: "operator" }, actor);
    passRequiredGates(runService, "e2e:live");
    runService.attestPrivacy("e2e:live", { accountPrivate: true, approvedFollowers: 0, contactsSyncOff: true, crossPostingOff: true, testMediaOnly: true }, "2026-08-26T16:21:10Z", "operator", actor);
    const context = { mode: "test_account", allowFinalPublish: true, allowedAccountIds: new Set([account().accountId]), releaseSha: "sha-w8" };
    const issued = permitService.issue({ runId: "e2e:live", intent: intent(), context, now: "2026-08-26T16:21:20Z", operatorId: "operator" }, actor);
    const invoker = new RetainedSessionFinalActionInvoker(registry, (() => { let i=30; return () => `2026-08-26T16:21:${String(i++).padStart(2,"0")}Z`; })());
    const controller = new PrivateE2EFinalActionController(store, store, invoker, permitService, () => "2026-08-26T16:21:40Z");
    const outcome = await controller.execute({ runId: "e2e:live", permitId: issued.permit.permitId, permitToken: issued.token, intentId: "intent:w8", attemptId: attempt.attemptId, context, workerId: "worker", now: "2026-08-26T16:21:25Z", actor });
    assert.equal(outcome.kind, "invoked");
    assert.equal(store.getIntent("intent:w8").state, "VERIFYING");
    assert.equal(store.getPublishAttempt(attempt.attemptId).result, "final_action_invoked");
    assert.equal(store.listVerificationEvidence("intent:w8", attempt.attemptId).filter((e) => e.kind === "ui_receipt").length, 1);
    await assert.rejects(() => controller.execute({ runId: "e2e:live", permitId: issued.permit.permitId, permitToken: issued.token, intentId: "intent:w8", attemptId: attempt.attemptId, context, workerId: "worker", now: "2026-08-26T16:21:50Z", actor }));
  } finally { await registry.closeAll(); store.close(); rmSync(paths.dir, { recursive: true, force: true }); }
});

test("host preflight requires private dirs and final publish disabled by default", async () => {
  const paths = tempRuntime(); const priorTZ = process.env.TZ; const priorFinal = process.env.ALLOW_FINAL_PUBLISH;
  process.env.TZ = "Europe/Vienna"; delete process.env.ALLOW_FINAL_PUBLISH;
  try {
    const result = await new NodeHostPreflightAdapter({ chromiumExecutablePath: resolveChromiumExecutablePath(), runtimeDir: paths.runtime, profilesDir: paths.profiles, evidenceDir: paths.evidence }).check("2026-08-26T16:30:00Z");
    assert.equal(result.ready, true);
  } finally { if (priorTZ === undefined) delete process.env.TZ; else process.env.TZ = priorTZ; if (priorFinal === undefined) delete process.env.ALLOW_FINAL_PUBLISH; else process.env.ALLOW_FINAL_PUBLISH = priorFinal; rmSync(paths.dir, { recursive: true, force: true }); }
});

test("AI provider preflight separates subscription CLI from service API credentials", () => {
  const subscription = aiProviderPreflight({ mode: "claude_subscription_cli", enabled: true, wrapperCommand: "/bin/echo" }, {});
  assert.equal(subscription.ready, true);
  const apiMissing = aiProviderPreflight({ mode: "anthropic_api", enabled: true, wrapperCommand: "/bin/echo" }, {});
  assert.equal(apiMissing.ready, false);
  const apiReady = aiProviderPreflight({ mode: "anthropic_api", enabled: true, wrapperCommand: "/bin/echo" }, { ANTHROPIC_API_KEY: "secret" });
  assert.equal(apiReady.ready, true);
});
