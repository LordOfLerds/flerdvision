import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteControlPlaneStore } from "../dist/adapters/storage/sqlite.js";
import { ChromiumCdpRuntimeAdapter } from "../dist/adapters/browser/chromium-cdp.js";
import { BrowserProfileDirectoryResolver, FileBrowserProfileLockAdapter } from "../dist/adapters/browser/profile-lock.js";
import { DeclarativeProfileVerificationCollector } from "../dist/adapters/verify/profile.js";
import { LocalVerificationArtifactSink } from "../dist/adapters/verify/artifacts.js";
import { RestartRecoveryService } from "../dist/application/recovery.js";
import { DurableFinalActionService, FinalActionLifecycleError } from "../dist/application/durable-final-action.js";
import { ReconciliationService } from "../dist/application/reconciliation.js";
import { CompositeReconciliationPolicy } from "../dist/domain/verification.js";
import { ManualVerifierAdapter } from "../dist/adapters/verify/manual.js";

const actor = { type: "test", id: "w5" };
const operator = { type: "operator", id: "ops-test" };
const context = {
  mode: "test_account",
  allowFinalPublish: true,
  allowedAccountIds: new Set(["acct:test"]),
  releaseSha: "w5-test"
};

function setupStore() {
  const store = new SqliteControlPlaneStore(":memory:");
  store.registerSocialAccount({ accountId: "acct:test", creatorId: "creator:test", platform: "instagram", expectedHandle: "test_handle", enabled: true }, "2026-08-26T16:00:00Z", actor);
  store.registerBrowserIdentity({ identityId: "browser:test", accountId: "acct:test", platform: "instagram", profileKey: "instagram/test", expectedHandle: "test_handle", enabled: true }, "2026-08-26T16:00:01Z", actor);
  store.createOrGetIntent({
    intentId: "intent:test", contentId: "content:test", creatorId: "creator:test", platform: "instagram",
    accountId: "acct:test", format: "reel", copyVersionId: "copy:test",
    scheduledFor: "2026-08-26T17:00:00Z", idempotencyKey: "idem:test"
  }, "2026-08-26T16:00:02Z", actor);
  store.transitionIntent("intent:test", "READY", "2026-08-26T16:00:03Z", actor);
  store.transitionIntent("intent:test", "SCHEDULED", "2026-08-26T16:00:04Z", actor);
  store.transitionIntent("intent:test", "PREPARING", "2026-08-26T16:00:05Z", actor);
  store.recordPreparedAttempt({
    attemptId: "attempt:test:1", intentId: "intent:test", browserIdentityId: "browser:test", releaseSha: "w5-test",
    startedAt: "2026-08-26T16:00:05Z", finishedAt: "2026-08-26T16:00:10Z", result: "prepared",
    mediaSha256: "a".repeat(64), preparationArtifactRefs: ["runtime/prepare.png"], reachedFinalActionBoundary: true
  }, actor);
  return store;
}

class ReceiptInvoker {
  count = 0;
  constructor(mode = "ok") { this.mode = mode; }
  async invoke(intent, attempt) {
    this.count += 1;
    if (this.mode === "throw_after_click") throw new Error("simulated connection loss after click");
    return {
      invokedAt: "2026-08-26T16:01:00Z",
      finishedAt: "2026-08-26T16:01:01Z",
      evidence: [{
        evidenceId: "e:receipt:1", intentId: intent.intentId, attemptId: attempt.attemptId,
        kind: "ui_receipt", observedAt: "2026-08-26T16:01:01Z", positive: true,
        artifactRef: "runtime/receipt.png"
      }]
    };
  }
}

class SequenceCollector {
  name = "sequence";
  constructor(sequence) { this.sequence = [...sequence]; }
  async collect() { return this.sequence.shift() ?? []; }
}

function evidence(id, kind, observedAt, positive, extra = {}) {
  return { evidenceId: id, intentId: "intent:test", attemptId: "attempt:test:1", kind, observedAt, positive, ...extra };
}

test("migration 5 creates append-only verification tables", () => {
  const dir = mkdtempSync(join(tmpdir(), "flerdvision-w5-db-"));
  const dbPath = join(dir, "db.sqlite");
  const store = new SqliteControlPlaneStore(dbPath);
  try {
    const versions = new DatabaseSync(dbPath).prepare("SELECT version FROM schema_migrations ORDER BY version").all().map((r) => Number(r.version));
    assert.deepEqual(versions.slice(0, 5), [1, 2, 3, 4, 5]);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
  }
});

test("durable final action persists boundary before invocation and receipt before verification", async () => {
  const store = setupStore();
  const invoker = new ReceiptInvoker();
  let clock = "2026-08-26T16:00:59Z";
  try {
    const service = new DurableFinalActionService(store, invoker, () => clock);
    const result = await service.execute("intent:test", "attempt:test:1", context, actor);
    assert.equal(result.kind, "invoked");
    assert.equal(invoker.count, 1);
    const attempt = store.getPublishAttempt("attempt:test:1");
    assert.equal(attempt.result, "final_action_invoked");
    assert.equal(attempt.irreversibleBoundaryEnteredAt, "2026-08-26T16:00:59.000Z");
    assert.equal(store.getIntent("intent:test").state, "VERIFYING");
    assert.equal(store.listVerificationEvidence("intent:test").length, 1);
  } finally { store.close(); }
});

test("exception after irreversible boundary becomes uncertain and cannot invoke a second time", async () => {
  const store = setupStore();
  const invoker = new ReceiptInvoker("throw_after_click");
  let tick = 0;
  const times = ["2026-08-26T16:00:59Z", "2026-08-26T16:01:02Z"];
  try {
    const service = new DurableFinalActionService(store, invoker, () => times[Math.min(tick++, times.length - 1)]);
    const first = await service.execute("intent:test", "attempt:test:1", context, actor);
    assert.equal(first.kind, "uncertain");
    assert.equal(store.getIntent("intent:test").state, "PUBLISH_UNCERTAIN");
    assert.equal(store.getPublishAttempt("attempt:test:1").result, "uncertain");
    await assert.rejects(() => service.execute("intent:test", "attempt:test:1", context, actor), FinalActionLifecycleError);
    assert.equal(invoker.count, 1);
  } finally { store.close(); }
});

test("positive receipt plus profile permalink verifies exactly one publication", async () => {
  const store = setupStore();
  try {
    await new DurableFinalActionService(store, new ReceiptInvoker(), () => "2026-08-26T16:00:59Z")
      .execute("intent:test", "attempt:test:1", context, actor);
    const collector = new SequenceCollector([[evidence("e:profile:1", "profile_permalink", "2026-08-26T16:02:00Z", true, { locator: "https://example.invalid/p/1" })]]);
    const result = await new ReconciliationService(store, [collector], new CompositeReconciliationPolicy(), () => "2026-08-26T16:02:01Z")
      .reconcile("intent:test", "attempt:test:1", actor);
    assert.equal(result.decision.outcome, "VERIFIED");
    assert.equal(store.getIntent("intent:test").state, "VERIFIED");
    assert.equal(store.getVerifiedPublication("intent:test").permalink, "https://example.invalid/p/1");
    assert.equal(store.listVerifiedPublications().length, 1);
  } finally { store.close(); }
});

test("three spaced negative profile checks are required before SAFE_TO_RETRY", async () => {
  const store = setupStore();
  try {
    store.enterIrreversibleBoundary("attempt:test:1", "2026-08-26T16:01:00Z", actor);
    store.markAttemptUncertain("attempt:test:1", "2026-08-26T16:01:01Z", actor, "simulated crash");
    const collector = new SequenceCollector([
      [evidence("neg:1", "negative_profile_check", "2026-08-26T16:03:00Z", false)],
      [evidence("neg:2", "negative_profile_check", "2026-08-26T16:04:00Z", false)],
      [evidence("neg:3", "negative_profile_check", "2026-08-26T16:05:00Z", false)]
    ]);
    const policy = new CompositeReconciliationPolicy({ negativeChecksRequired: 3, minimumNegativeSpanSeconds: 120, minimumAgeAfterBoundarySeconds: 120 });
    const times = ["2026-08-26T16:03:01Z", "2026-08-26T16:04:01Z", "2026-08-26T16:05:01Z"];
    let i = 0;
    const service = new ReconciliationService(store, [collector], policy, () => times[Math.min(i++, times.length - 1)]);
    const one = await service.reconcile("intent:test", "attempt:test:1", actor);
    assert.equal(one.decision.outcome, "UNCERTAIN");
    assert.equal(store.getIntent("intent:test").state, "PUBLISH_UNCERTAIN");
    const two = await service.reconcile("intent:test", "attempt:test:1", actor);
    assert.equal(two.decision.outcome, "UNCERTAIN");
    const three = await service.reconcile("intent:test", "attempt:test:1", actor);
    assert.equal(three.decision.outcome, "SAFE_TO_RETRY");
    assert.equal(store.getIntent("intent:test").state, "RETRY_WAIT");
  } finally { store.close(); }
});

test("any positive publish signal prevents automatic safe retry", async () => {
  const store = setupStore();
  try {
    store.enterIrreversibleBoundary("attempt:test:1", "2026-08-26T16:01:00Z", actor);
    store.markAttemptUncertain("attempt:test:1", "2026-08-26T16:01:01Z", actor, "simulated crash");
    for (const item of [
      evidence("pos:receipt", "ui_receipt", "2026-08-26T16:01:02Z", true),
      evidence("neg:a", "negative_profile_check", "2026-08-26T16:03:00Z", false),
      evidence("neg:b", "negative_profile_check", "2026-08-26T16:04:00Z", false),
      evidence("neg:c", "negative_profile_check", "2026-08-26T16:05:00Z", false)
    ]) store.recordVerificationEvidence(item, actor);
    const result = await new ReconciliationService(store, [], new CompositeReconciliationPolicy({ minimumNegativeSpanSeconds: 60, minimumAgeAfterBoundarySeconds: 60 }), () => "2026-08-26T16:05:01Z")
      .reconcile("intent:test", "attempt:test:1", actor);
    assert.equal(result.decision.outcome, "UNCERTAIN");
    assert.equal(store.getIntent("intent:test").state, "PUBLISH_UNCERTAIN");
  } finally { store.close(); }
});

test("authorized manual published verification plus permalink reaches verified quorum", async () => {
  const store = setupStore();
  try {
    store.enterIrreversibleBoundary("attempt:test:1", "2026-08-26T16:01:00Z", actor);
    store.markAttemptUncertain("attempt:test:1", "2026-08-26T16:01:01Z", actor, "unknown");
    await new ManualVerifierAdapter(store, undefined, () => "2026-08-26T16:03:00Z")
      .confirmPublished("intent:test", "attempt:test:1", operator, { permalink: "https://example.invalid/manual/1", note: "checked profile" });
    const result = await new ReconciliationService(store, [], new CompositeReconciliationPolicy(), () => "2026-08-26T16:03:01Z")
      .reconcile("intent:test", "attempt:test:1", actor);
    assert.equal(result.decision.outcome, "VERIFIED");
    assert.equal(store.getIntent("intent:test").state, "VERIFIED");
  } finally { store.close(); }
});

test("authorized manual absence can move uncertain intent only to RETRY_WAIT", async () => {
  const store = setupStore();
  try {
    store.enterIrreversibleBoundary("attempt:test:1", "2026-08-26T16:01:00Z", actor);
    store.markAttemptUncertain("attempt:test:1", "2026-08-26T16:01:01Z", actor, "unknown");
    await new ManualVerifierAdapter(store, undefined, () => "2026-08-26T16:03:00Z")
      .confirmNotPublished("intent:test", "attempt:test:1", operator, "checked profile and drafts; publication absent");
    const result = await new ReconciliationService(store, [], new CompositeReconciliationPolicy(), () => "2026-08-26T16:03:01Z")
      .reconcile("intent:test", "attempt:test:1", actor);
    assert.equal(result.decision.outcome, "SAFE_TO_RETRY");
    assert.equal(store.getIntent("intent:test").state, "RETRY_WAIT");
    assert.notEqual(store.getIntent("intent:test").state, "READY");
  } finally { store.close(); }
});

test("verification evidence and publications are append-only in SQLite", async () => {
  const dir = mkdtempSync(join(tmpdir(), "flerdvision-w5-append-"));
  const dbPath = join(dir, "db.sqlite");
  const store = new SqliteControlPlaneStore(dbPath);
  try {
    store.registerSocialAccount({ accountId: "acct:test", platform: "instagram", expectedHandle: "test_handle", enabled: true }, "2026-08-26T16:00:00Z", actor);
    store.registerBrowserIdentity({ identityId: "browser:test", accountId: "acct:test", platform: "instagram", profileKey: "instagram/test", expectedHandle: "test_handle", enabled: true }, "2026-08-26T16:00:01Z", actor);
    store.createOrGetIntent({ intentId: "intent:test", contentId: "content:test", creatorId: "creator:test", platform: "instagram", accountId: "acct:test", format: "reel", copyVersionId: "copy", scheduledFor: "2026-08-26T17:00:00Z", idempotencyKey: "idem" }, "2026-08-26T16:00:02Z", actor);
    store.transitionIntent("intent:test", "READY", "2026-08-26T16:00:03Z", actor);
    store.transitionIntent("intent:test", "SCHEDULED", "2026-08-26T16:00:04Z", actor);
    store.transitionIntent("intent:test", "PREPARING", "2026-08-26T16:00:05Z", actor);
    store.recordPreparedAttempt({ attemptId: "attempt:test:1", intentId: "intent:test", browserIdentityId: "browser:test", releaseSha: "x", startedAt: "2026-08-26T16:00:05Z", result: "prepared", reachedFinalActionBoundary: true }, actor);
    store.recordVerificationEvidence(evidence("immutable:e", "negative_profile_check", "2026-08-26T16:01:00Z", false), actor);
    store.close();
    const raw = new DatabaseSync(dbPath);
    assert.throws(() => raw.prepare("UPDATE verification_evidence SET note='tamper' WHERE evidence_id='immutable:e'").run(), /append-only/);
    assert.throws(() => raw.prepare("DELETE FROM verification_evidence WHERE evidence_id='immutable:e'").run(), /append-only/);
    raw.close();
  } finally {
    try { store.close(); } catch {}
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
  }
});

test("hard restart after durable boundary also marks the persisted attempt uncertain", () => {
  const store = setupStore();
  try {
    store.enterIrreversibleBoundary("attempt:test:1", "2026-08-26T16:01:00Z", actor);
    const report = new RestartRecoveryService(store).recover("2026-08-26T16:01:30Z", actor);
    assert.deepEqual(report.uncertainMarked, ["intent:test"]);
    assert.equal(store.getIntent("intent:test").state, "PUBLISH_UNCERTAIN");
    assert.equal(store.getPublishAttempt("attempt:test:1").result, "uncertain");
  } finally { store.close(); }
});

async function profileCollectorFixture(html) {
  const dir = mkdtempSync(join(tmpdir(), "flerdvision-w5-profile-"));
  const profiles = join(dir, "profiles");
  const evidenceRoot = join(dir, "evidence");
  const store = setupStore();
  store.enterIrreversibleBoundary("attempt:test:1", "2026-08-26T16:01:00Z", actor);
  store.markAttemptUncertain("attempt:test:1", "2026-08-26T16:01:01Z", actor, "fixture");
  const base = new ChromiumCdpRuntimeAdapter({ profilesRoot: profiles });
  const runtime = {
    async launch(identity, options) {
      const page = await base.launch(identity, options);
      return {
        identityId: page.identityId,
        profileDirectory: page.profileDirectory,
        async navigate(url) {
          await page.navigate("about:blank");
          await page.evaluate(`document.body.innerHTML = ${JSON.stringify(html)}; history.replaceState({}, '', '#profile')`);
        },
        currentUrl: () => page.currentUrl(),
        evaluate: (expression) => page.evaluate(expression),
        setInputFiles: (selector, paths) => page.setInputFiles(selector, paths),
        captureScreenshot: (path) => page.captureScreenshot(path),
        setCookie: (url, name, value, expires) => page.setCookie(url, name, value, expires),
        cookies: (url) => page.cookies(url),
        close: () => page.close()
      };
    }
  };
  const collector = new DeclarativeProfileVerificationCollector(
    store,
    runtime,
    new FileBrowserProfileLockAdapter(new BrowserProfileDirectoryResolver(profiles)),
    { async probe() { return { state: "HEALTHY", observedHandle: "test_handle", currentUrl: "about:blank" }; } },
    new LocalVerificationArtifactSink(evidenceRoot),
    {
      platform: "instagram",
      bootstrapUrl: "about:blank",
      profileUrlTemplate: "https://example.invalid/{handle}",
      profileReadyLocators: [{ kind: "css", value: "#profile-ready" }],
      postMatchLocators: [{ kind: "css", value: "[data-intent='{intentId}']" }],
      permalinkAttribute: "href"
    },
    { ownerId: "w5-profile-test", headless: true, profileReadyTimeoutMs: 300, matchTimeoutMs: 150, now: () => "2026-08-26T16:04:00Z" }
  );
  return { dir, store, collector };
}

test("declarative profile verifier emits permalink evidence only from a ready profile surface", async () => {
  const fixture = await profileCollectorFixture(`<main id="profile-ready"><a data-intent="intent:test" href="https://example.invalid/post/42">post</a></main>`);
  try {
    const attempt = fixture.store.getPublishAttempt("attempt:test:1");
    const intent = fixture.store.getIntent("intent:test").intent;
    const items = await fixture.collector.collect(intent, attempt);
    assert.equal(items.length, 1);
    assert.equal(items[0].kind, "profile_permalink");
    assert.equal(items[0].positive, true);
    assert.equal(items[0].locator, "https://example.invalid/post/42");
    assert.ok(items[0].artifactRef);
  } finally {
    fixture.store.close();
    rmSync(fixture.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
  }
});

test("declarative profile verifier emits negative evidence only after profile-ready proof", async () => {
  const fixture = await profileCollectorFixture(`<main id="profile-ready"><span>no matching post</span></main>`);
  try {
    const items = await fixture.collector.collect(fixture.store.getIntent("intent:test").intent, fixture.store.getPublishAttempt("attempt:test:1"));
    assert.equal(items.length, 1);
    assert.equal(items[0].kind, "negative_profile_check");
    assert.equal(items[0].positive, false);
    assert.ok(items[0].artifactRef);
  } finally {
    fixture.store.close();
    rmSync(fixture.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
  }
});

test("profile verifier never turns an unknown/not-ready surface into negative absence evidence", async () => {
  const fixture = await profileCollectorFixture(`<main><span>broken or still loading</span></main>`);
  try {
    await assert.rejects(
      () => fixture.collector.collect(fixture.store.getIntent("intent:test").intent, fixture.store.getPublishAttempt("attempt:test:1")),
      /known-ready state/
    );
    assert.equal(fixture.store.listVerificationEvidence("intent:test").length, 0);
  } finally {
    fixture.store.close();
    rmSync(fixture.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
  }
});

test("reconciliation of an already verified intent is idempotent and cannot create a second publication", async () => {
  const store = setupStore();
  try {
    await new DurableFinalActionService(store, new ReceiptInvoker(), () => "2026-08-26T16:00:59Z")
      .execute("intent:test", "attempt:test:1", context, actor);
    const collector = new SequenceCollector([[evidence("e:profile:idem", "profile_permalink", "2026-08-26T16:02:00Z", true, { locator: "https://example.invalid/p/idem" })]]);
    const service = new ReconciliationService(store, [collector], new CompositeReconciliationPolicy(), () => "2026-08-26T16:02:01Z");
    const first = await service.reconcile("intent:test", "attempt:test:1", actor);
    assert.equal(first.decision.outcome, "VERIFIED");
    const second = await service.reconcile("intent:test", "attempt:test:1", actor);
    assert.equal(second.decision.outcome, "VERIFIED");
    assert.equal(store.listVerifiedPublications().length, 1);
    assert.equal(store.getVerifiedPublication("intent:test").permalink, "https://example.invalid/p/idem");
  } finally { store.close(); }
});

test("verified publication cannot be persisted without evidence references", () => {
  const store = setupStore();
  try {
    assert.throws(() => store.recordVerifiedPublication({
      publicationId: "publication:invalid", intentId: "intent:test", verifiedAt: "2026-08-26T16:02:00Z", evidenceIds: []
    }, actor), /requires evidence/);
  } finally { store.close(); }
});

test("reconciliation repairs intent state if publication record survived but final VERIFIED transition did not", async () => {
  const store = setupStore();
  try {
    await new DurableFinalActionService(store, new ReceiptInvoker(), () => "2026-08-26T16:00:59Z")
      .execute("intent:test", "attempt:test:1", context, actor);
    store.recordVerificationEvidence(evidence("recover:profile", "profile_permalink", "2026-08-26T16:02:00Z", true, { locator: "https://example.invalid/recovered" }), actor);
    store.recordVerifiedPublication({
      publicationId: "publication:intent:test",
      intentId: "intent:test",
      verifiedAt: "2026-08-26T16:02:01Z",
      permalink: "https://example.invalid/recovered",
      evidenceIds: ["recover:profile", "e:receipt:1"]
    }, actor);
    assert.equal(store.getIntent("intent:test").state, "VERIFYING");
    const result = await new ReconciliationService(store, [], new CompositeReconciliationPolicy(), () => "2026-08-26T16:02:02Z")
      .reconcile("intent:test", "attempt:test:1", actor);
    assert.equal(result.decision.outcome, "VERIFIED");
    assert.equal(store.getIntent("intent:test").state, "VERIFIED");
    assert.equal(store.listVerifiedPublications().length, 1);
  } finally { store.close(); }
});

// --- post-page deep verification: Instagram's grid renders no captions, and a reel without
// share-to-feed exists only under the reels tab. The live acceptance sat at UNCERTAIN with a
// success receipt on file because the marker is only readable on the opened post page.

async function postListCollectorFixture({ profileHtml, listHtml, postHtml }) {
  const dir = mkdtempSync(join(tmpdir(), "flerdvision-w5-postlist-"));
  const profiles = join(dir, "profiles");
  const evidenceRoot = join(dir, "evidence");
  const store = setupStore();
  store.enterIrreversibleBoundary("attempt:test:1", "2026-08-26T16:01:00Z", actor);
  store.markAttemptUncertain("attempt:test:1", "2026-08-26T16:01:01Z", actor, "fixture");
  const base = new ChromiumCdpRuntimeAdapter({ profilesRoot: profiles });
  const runtime = {
    async launch(identity, options) {
      const page = await base.launch(identity, options);
      return {
        identityId: page.identityId,
        profileDirectory: page.profileDirectory,
        async navigate(url) {
          let html = profileHtml;
          if (url.includes("/reels/")) html = listHtml;
          else if (url.includes("/reel/")) html = postHtml[url] ?? `<main id="profile-ready">leer</main>`;
          await page.navigate("about:blank");
          await page.evaluate(`document.body.innerHTML = ${JSON.stringify(html)}; history.replaceState({}, '', '#page')`);
        },
        currentUrl: () => page.currentUrl(),
        evaluate: (expression) => page.evaluate(expression),
        setInputFiles: (selector, paths) => page.setInputFiles(selector, paths),
        captureScreenshot: (path) => page.captureScreenshot(path),
        setCookie: (url, name, value, expires) => page.setCookie(url, name, value, expires),
        cookies: (url) => page.cookies(url),
        close: () => page.close()
      };
    }
  };
  const collector = new DeclarativeProfileVerificationCollector(
    store,
    runtime,
    new FileBrowserProfileLockAdapter(new BrowserProfileDirectoryResolver(profiles)),
    { async probe() { return { state: "HEALTHY", observedHandle: "test_handle", currentUrl: "about:blank" }; } },
    new LocalVerificationArtifactSink(evidenceRoot),
    {
      platform: "instagram",
      bootstrapUrl: "about:blank",
      profileUrlTemplate: "https://example.invalid/{handle}",
      profileReadyLocators: [{ kind: "css", value: "#profile-ready" }],
      postMatchLocators: [{ kind: "css", value: "[data-intent='{intentId}']" }],
      permalinkAttribute: "href",
      postListUrlTemplate: "https://example.invalid/{handle}/reels/",
      postLinkSelector: "a.post-link",
      postOpenLimit: 3
    },
    { ownerId: "w5-postlist-test", headless: true, profileReadyTimeoutMs: 300, matchTimeoutMs: 200, now: () => "2026-08-26T16:04:00Z" }
  );
  return { dir, store, collector };
}

test("the marker on an opened post page yields permalink evidence when the profile page is blind", async () => {
  const fixture = await postListCollectorFixture({
    profileHtml: `<main id="profile-ready">grid ohne captions</main>`,
    listHtml: `<main id="profile-ready"><a class="post-link" href="/test_handle/reel/abc/">1</a><a class="post-link" href="/test_handle/reel/def/">2</a></main>`,
    postHtml: {
      "https://example.invalid/test_handle/reel/abc/": `<main id="profile-ready">anderer beitrag</main>`,
      "https://example.invalid/test_handle/reel/def/": `<main id="profile-ready"><div data-intent="intent:test">caption mit marker</div></main>`
    }
  });
  try {
    const attempt = fixture.store.getPublishAttempt("attempt:test:1");
    const intent = fixture.store.getIntent("intent:test").intent;
    const items = await fixture.collector.collect(intent, attempt);
    assert.equal(items.length, 1);
    assert.equal(items[0].kind, "profile_permalink");
    assert.equal(items[0].positive, true);
    assert.equal(items[0].locator, "https://example.invalid/test_handle/reel/def/");
    assert.ok(items[0].artifactRef);
  } finally { rmSync(fixture.dir, { recursive: true, force: true }); }
});

test("no marker anywhere stays a negative check naming how many post pages were opened", async () => {
  const fixture = await postListCollectorFixture({
    profileHtml: `<main id="profile-ready">grid</main>`,
    listHtml: `<main id="profile-ready"><a class="post-link" href="/test_handle/reel/abc/">1</a><a class="post-link" href="/test_handle/reel/def/">2</a></main>`,
    postHtml: {}
  });
  try {
    const attempt = fixture.store.getPublishAttempt("attempt:test:1");
    const intent = fixture.store.getIntent("intent:test").intent;
    const items = await fixture.collector.collect(intent, attempt);
    assert.equal(items.length, 1);
    assert.equal(items[0].positive, false);
    assert.match(items[0].note, /2 opened post page/);
  } finally { rmSync(fixture.dir, { recursive: true, force: true }); }
});

test("the compiler equips instagram verification specs with the reels-tab deep check", () => {
  const compiler = readFileSync(new URL("../src/application/workspace-spec-compiler.ts", import.meta.url).pathname, "utf8");
  assert.match(compiler, /postListUrlTemplate: `\$\{profileUrl\(channel\)\}reels\/`/);
  assert.match(compiler, /postLinkSelector: 'a\[href\*="\/reel\/"\]'/);
});

test("the spec parser round-trips the deep-check fields instead of stripping them", async () => {
  const { parseProfileVerificationSpecFile } = await import("../dist/adapters/verify/profile-spec-config.js");
  const file = parseProfileVerificationSpecFile({
    schemaVersion: 1,
    specs: [{
      specId: "s1", platform: "instagram", accountId: "acc", calibrationStatus: "CALIBRATED",
      calibratedAt: "2026-08-30T14:55:00.000Z", calibratedBy: "test",
      spec: {
        platform: "instagram", bootstrapUrl: "https://www.instagram.com/",
        profileUrlTemplate: "https://www.instagram.com/{handle}/",
        profileReadyLocators: [{ kind: "css", value: "main" }],
        postMatchLocators: [{ kind: "text", value: "{contentId}", exact: false }],
        permalinkAttribute: "href",
        postListUrlTemplate: "https://www.instagram.com/{handle}/reels/",
        postLinkSelector: 'a[href*="/reel/"]',
        postOpenLimit: 3
      }
    }]
  });
  assert.equal(file.specs[0].spec.postListUrlTemplate, "https://www.instagram.com/{handle}/reels/");
  assert.equal(file.specs[0].spec.postLinkSelector, 'a[href*="/reel/"]');
  assert.equal(file.specs[0].spec.postOpenLimit, 3);
  assert.throws(() => parseProfileVerificationSpecFile({
    schemaVersion: 1,
    specs: [{ specId: "s2", platform: "instagram", calibrationStatus: "UNVERIFIED",
      spec: { platform: "instagram", bootstrapUrl: "https://x.example/", profileUrlTemplate: "https://x.example/{handle}",
        profileReadyLocators: [{ kind: "css", value: "main" }], postMatchLocators: [{ kind: "text", value: "x", exact: false }],
        postListUrlTemplate: "https://x.example/list" } }]
  }), /together/);
});

test("a calibrated spec whose template moved on is re-emitted fresh instead of preserved stale", () => {
  const compiler = readFileSync(new URL("../src/application/workspace-spec-compiler.ts", import.meta.url).pathname, "utf8");
  // The live gap: preservedCalibratedEntry returned the stale calibrated entry verbatim, so the
  // reels-tab deep check never reached a calibrated verification spec through any bootstrap.
  assert.match(compiler, /preservedCalibratedEntry\(verificationPath, "specs", accountId, channel\.platform, freshSpec\)/);
  const idx = compiler.indexOf("function preservedCalibratedEntry");
  const block = compiler.slice(idx, idx + 1200);
  assert.match(block, /semanticEqual\(entry\[payloadKey\], freshPayload\)/);
  assert.match(block, /return undefined/);
});
