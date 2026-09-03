import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteControlPlaneStore } from "../dist/adapters/storage/sqlite.js";
import { BrowserProfileDirectoryResolver, FileBrowserProfileLockAdapter } from "../dist/adapters/browser/profile-lock.js";
import { DeclarativeProfileVerificationCollector } from "../dist/adapters/verify/profile.js";
import { LocalVerificationArtifactSink } from "../dist/adapters/verify/artifacts.js";
import { classifyCaptionMatch, parseDurationSeconds, parsePostTimestamp } from "../dist/adapters/verify/caption-match.js";
import { parseProfileVerificationSpecFile } from "../dist/adapters/verify/profile-spec-config.js";

// Production posts carry no [FV:contentId] marker any more, so the verifier can no longer find
// "its" post by reading a token off the page. It opens the account's own newest posts and
// requires exactly one post inside the run's publish window whose caption is exactly the caption
// the run posted. Everything here runs against a fake browser session: no network, no Chromium.

const actor = { type: "test", id: "r18" };
const POSTED_CAPTION = "Sonnenuntergang am See #nature #chill";
const LIST_URL = "https://example.invalid/flerdvision/reels/";
const PROFILE_URL = "https://example.invalid/flerdvision/";
const BOUNDARY_AT = "2026-09-03T10:05:00Z";
const FINAL_ACTION_AT = "2026-09-03T10:05:10Z";
const NOW = "2026-09-03T10:06:00Z";

function setupStore() {
  const store = new SqliteControlPlaneStore(":memory:");
  store.registerSocialAccount({ accountId: "acct:test", creatorId: "creator:test", platform: "instagram", expectedHandle: "flerdvision", enabled: true }, "2026-09-03T09:00:00Z", actor);
  store.registerBrowserIdentity({ identityId: "browser:test", accountId: "acct:test", platform: "instagram", profileKey: "instagram/test", expectedHandle: "flerdvision", enabled: true }, "2026-09-03T09:00:01Z", actor);
  store.createOrGetIntent({
    intentId: "intent:test", contentId: "content:test", creatorId: "creator:test", platform: "instagram",
    accountId: "acct:test", format: "reel", copyVersionId: "copy:test",
    scheduledFor: "2026-09-03T10:00:00Z", idempotencyKey: "idem:test"
  }, "2026-09-03T09:00:02Z", actor);
  for (const state of ["READY", "SCHEDULED", "PREPARING"]) store.transitionIntent("intent:test", state, "2026-09-03T09:00:03Z", actor);
  store.recordPreparedAttempt({
    attemptId: "attempt:test:1", intentId: "intent:test", browserIdentityId: "browser:test", releaseSha: "r18-test",
    startedAt: "2026-09-03T10:00:00Z", result: "prepared", mediaSha256: "b".repeat(64), reachedFinalActionBoundary: true
  }, actor);
  // Boundary entry moves the intent to PUBLISHING itself; the final click is recorded after it.
  store.enterIrreversibleBoundary("attempt:test:1", BOUNDARY_AT, actor);
  store.markFinalActionInvoked("attempt:test:1", FINAL_ACTION_AT, actor);
  return store;
}

/** Minimal page session: it answers exactly the expressions the collector actually evaluates. */
class FakePage {
  constructor(pages, profileDirectory) {
    this.pages = pages;
    this.identityId = "browser:test";
    this.profileDirectory = profileDirectory;
    this.url = "about:blank";
    this.visited = [];
  }
  async navigate(url) { this.url = url; this.visited.push(url); }
  async currentUrl() { return this.url; }
  async evaluate(expression) {
    const page = this.pages[this.url] ?? {};
    if (expression.includes('getAttribute("href")')) return page.links ?? [];
    if (expression.includes("__FV_POST_READ__")) {
      if (!page.post) return { caption: "", captionSelector: "", timestampRaw: "", durationRaw: "", durationProperty: null };
      return { caption: "", captionSelector: "caption", timestampRaw: "", durationRaw: "", durationProperty: null, ...page.post };
    }
    if (expression.includes("outerHTML")) return `<html><!-- ${this.url} --></html>`;
    if (expression.includes("data-flerdvision-node")) return page.ready === false ? null : { token: "fv-node", descriptor: "css:main" };
    if (expression.includes("scrollBy")) return true;
    return null;
  }
  async captureScreenshot(path) { writeFileSync(path, "fake-png"); }
  async close() {}
}

function captionSpec(extra = {}) {
  return {
    platform: "instagram",
    bootstrapUrl: "https://example.invalid/",
    profileUrlTemplate: PROFILE_URL,
    profileReadyLocators: [{ kind: "css", value: "main" }],
    postListUrlTemplate: LIST_URL,
    postLinkSelector: 'a[href*="/reel/"]',
    postOpenLimit: 3,
    captionMatch: {
      captionSelectors: ["h1"],
      timestampSelector: "time",
      timestampAttribute: "datetime",
      durationSelector: "video",
      ...extra
    }
  };
}

function fixture(pages, { spec = captionSpec(), expectedCopy } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "flerdvision-r18-"));
  const store = setupStore();
  const page = new FakePage({ [PROFILE_URL]: { ready: true }, ...pages }, join(dir, "profiles", "instagram", "test"));
  const collector = new DeclarativeProfileVerificationCollector(
    store,
    { async launch() { return page; } },
    new FileBrowserProfileLockAdapter(new BrowserProfileDirectoryResolver(join(dir, "profiles"))),
    { async probe() { return { state: "HEALTHY", observedHandle: "flerdvision", currentUrl: PROFILE_URL }; } },
    new LocalVerificationArtifactSink(join(dir, "evidence")),
    spec,
    {
      ownerId: "r18", headless: true, profileReadyTimeoutMs: 300, matchTimeoutMs: 150, now: () => NOW,
      ...(expectedCopy ? { expectedCopy } : {})
    }
  );
  return {
    dir, store, page, collector,
    async collect() { return await collector.collect(store.getIntent("intent:test").intent, store.getPublishAttempt("attempt:test:1")); },
    dispose() { store.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }); }
  };
}

const postedCopy = { async expected() { return { caption: POSTED_CAPTION, mediaDurationSeconds: 7.2 }; } };

function postPage(url, caption, timestampRaw, durationProperty = null) {
  return { [url]: { ready: true, post: { caption, timestampRaw, durationProperty } } };
}

test("an exact caption match inside the window verifies the post and returns its permalink", async () => {
  const url = "https://example.invalid/reel/AAA/";
  const it = fixture(
    { [LIST_URL]: { ready: true, links: [url] }, ...postPage(url, `${POSTED_CAPTION}\n`, "2026-09-03T10:05:30Z") },
    { expectedCopy: postedCopy }
  );
  try {
    const evidence = await it.collect();
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0].kind, "profile_permalink");
    assert.equal(evidence[0].positive, true);
    assert.equal(evidence[0].locator, url);
    assert.ok(evidence[0].artifactRef, "the opened post page is captured as evidence");
    assert.ok(existsSync(evidence[0].artifactRef), "and the returned screenshot path actually exists");
    assert.match(evidence[0].artifactRef, /profile-verification-post\.png$/);
  } finally { it.dispose(); }
});

test("a caption that differs is never accepted and never counts as absence", async () => {
  const url = "https://example.invalid/reel/BBB/";
  const it = fixture(
    { [LIST_URL]: { ready: true, links: [url] }, ...postPage(url, "Ganz andere Caption", "2026-09-03T10:05:30Z") },
    { expectedCopy: postedCopy }
  );
  try {
    const evidence = await it.collect();
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0].kind, "inconclusive_profile_check");
    assert.equal(evidence[0].positive, false);
    assert.match(evidence[0].note, /1 Posts im Zeitfenster, keiner mit passender Caption/);
  } finally { it.dispose(); }
});

test("two posts with the same caption stay uncertain instead of picking the newest", async () => {
  const first = "https://example.invalid/reel/CCC/", second = "https://example.invalid/reel/DDD/";
  const it = fixture(
    {
      [LIST_URL]: { ready: true, links: [first, second] },
      ...postPage(first, POSTED_CAPTION, "2026-09-03T10:05:30Z"),
      ...postPage(second, POSTED_CAPTION, "2026-09-03T10:04:30Z")
    },
    { expectedCopy: { async expected() { return { caption: POSTED_CAPTION }; } } }
  );
  try {
    const evidence = await it.collect();
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0].kind, "inconclusive_profile_check");
    assert.match(evidence[0].note, /2 Posts im Zeitfenster mit identischer Caption/);
  } finally { it.dispose(); }
});

test("the media duration disambiguates two equal captions but is never the only proof", async () => {
  const first = "https://example.invalid/reel/EEE/", second = "https://example.invalid/reel/FFF/";
  const pages = {
    [LIST_URL]: { ready: true, links: [first, second] },
    ...postPage(first, POSTED_CAPTION, "2026-09-03T10:05:30Z", 31.4),
    ...postPage(second, POSTED_CAPTION, "2026-09-03T10:04:30Z", 7.0)
  };
  const it = fixture(pages, { expectedCopy: postedCopy });
  try {
    const evidence = await it.collect();
    assert.equal(evidence[0].kind, "profile_permalink");
    assert.equal(evidence[0].locator, second);
    assert.match(evidence[0].note, /Videolänge/);
  } finally { it.dispose(); }

  // Same duration on both: the tie-break must not invent a winner.
  const ambiguous = fixture(
    { ...pages, ...postPage(first, POSTED_CAPTION, "2026-09-03T10:05:30Z", 7.1) },
    { expectedCopy: postedCopy }
  );
  try {
    const evidence = await ambiguous.collect();
    assert.equal(evidence[0].kind, "inconclusive_profile_check");
  } finally { ambiguous.dispose(); }
});

test("posts older than the window are absence evidence, not a match", async () => {
  const url = "https://example.invalid/reel/GGG/";
  const it = fixture(
    { [LIST_URL]: { ready: true, links: [url] }, ...postPage(url, POSTED_CAPTION, "2026-09-01T09:00:00Z") },
    { expectedCopy: postedCopy }
  );
  try {
    const evidence = await it.collect();
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0].kind, "negative_profile_check");
    assert.equal(evidence[0].positive, false);
    assert.match(evidence[0].note, /Kein Post im Zeitfenster/);
  } finally { it.dispose(); }
});

test("without the posted copy the verifier reports caption readability instead of guessing", async () => {
  const url = "https://example.invalid/reel/HHH/";
  const it = fixture({ [LIST_URL]: { ready: true, links: [url] }, ...postPage(url, "", "2026-09-03T10:05:30Z") });
  try {
    const evidence = await it.collect();
    assert.equal(evidence[0].kind, "inconclusive_profile_check");
    assert.match(evidence[0].note, /kein Copy-Resolver/);
    assert.match(evidence[0].note, /0\/1 geöffnete Posts/);
  } finally { it.dispose(); }
});

test("a marker route keeps matching on the marker locator", async () => {
  const it = fixture(
    { [PROFILE_URL]: { ready: true } },
    {
      spec: {
        platform: "instagram",
        bootstrapUrl: "https://example.invalid/",
        profileUrlTemplate: PROFILE_URL,
        profileReadyLocators: [{ kind: "css", value: "main" }],
        postMatchLocators: [{ kind: "text", value: "{contentId}", exact: false }],
        permalinkAttribute: "href"
      }
    }
  );
  try {
    const evidence = await it.collect();
    assert.equal(evidence.length, 1);
    // The fake answers every locator read positively, which is exactly the marker path.
    assert.equal(evidence[0].positive, true);
    assert.ok(evidence[0].kind === "profile_permalink" || evidence[0].kind === "profile_media_match");
  } finally { it.dispose(); }
});

test("the window is applied on the read timestamp, and a date without a time is unusable", () => {
  assert.equal(parsePostTimestamp("2026-09-03T10:05:30Z"), Date.parse("2026-09-03T10:05:30Z"));
  assert.equal(parsePostTimestamp("2026-09-03"), undefined, "a date-only stamp must not be read as midnight");
  assert.equal(parsePostTimestamp(""), undefined);
  const older = { url: "u", caption: "x", captionSelector: "h1", timestampRaw: "2026-09-03T09:00:00Z", durationRaw: "", durationProperty: null };
  const outcome = classifyCaptionMatch({ posts: [older], expected: "x", windowStartMs: Date.parse("2026-09-03T10:03:10Z"), windowEndMs: Date.parse("2026-09-03T10:07:00Z") });
  assert.equal(outcome.verdict, "ABSENT");
  const undated = classifyCaptionMatch({ posts: [{ ...older, timestampRaw: "3.9.2026" }], expected: "x", windowStartMs: 0, windowEndMs: 10 });
  assert.equal(undated.verdict, "INCONCLUSIVE", "an unreadable publish time can never prove absence");
});

test("durations are read from seconds, clock notation and ISO-8601 alike", () => {
  assert.equal(parseDurationSeconds("", 7.25), 7.25);
  assert.equal(parseDurationSeconds("0:07", null), 7);
  assert.equal(parseDurationSeconds("1:02:03", null), 3723);
  assert.equal(parseDurationSeconds("PT1M7S", null), 67);
  assert.equal(parseDurationSeconds("7,5", null), 7.5);
  assert.equal(parseDurationSeconds("keine Ahnung", null), undefined);
});

test("a verification contract carries either a marker locator or a caption match, never both", () => {
  const base = {
    specId: "ig", platform: "instagram", calibrationStatus: "CALIBRATED", calibratedAt: "2026-09-03T10:00:00Z", calibratedBy: "test",
    spec: captionSpec()
  };
  const parsed = parseProfileVerificationSpecFile({ schemaVersion: 1, specs: [base] });
  assert.equal(parsed.specs[0].spec.captionMatch.timestampSelector, "time");
  assert.equal(parsed.specs[0].spec.postMatchLocators, undefined);
  assert.throws(
    () => parseProfileVerificationSpecFile({ schemaVersion: 1, specs: [{ ...base, spec: { ...captionSpec(), postMatchLocators: [{ kind: "text", value: "x" }] } }] }),
    /must not set postMatchLocators together with captionMatch/
  );
  const { captionMatch: _dropped, ...withoutRule } = captionSpec();
  assert.throws(
    () => parseProfileVerificationSpecFile({ schemaVersion: 1, specs: [{ ...base, spec: withoutRule }] }),
    /must set postMatchLocators or captionMatch/
  );
  const noTimestamp = captionSpec();
  delete noTimestamp.captionMatch.timestampSelector;
  assert.throws(
    () => parseProfileVerificationSpecFile({ schemaVersion: 1, specs: [{ ...base, spec: noTimestamp }] }),
    /timestampSelector must be a non-empty selector/
  );
  const noList = captionSpec();
  delete noList.postListUrlTemplate;
  delete noList.postLinkSelector;
  assert.throws(
    () => parseProfileVerificationSpecFile({ schemaVersion: 1, specs: [{ ...base, spec: noList }] }),
    /captionMatch requires postListUrlTemplate and postLinkSelector/
  );
});
