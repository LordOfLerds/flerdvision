import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { directYoutubeHint, youtubeVideoIdFromLocator } from "../dist/adapters/verify/direct-youtube.js";

test("YouTube object ids are recovered only from supported direct video URLs", () => {
  const videoId = "Abc_123-xyz";
  assert.equal(youtubeVideoIdFromLocator(`https://studio.youtube.com/video/${videoId}/edit`), videoId);
  assert.equal(youtubeVideoIdFromLocator(`https://www.youtube.com/shorts/${videoId}`), videoId);
  assert.equal(youtubeVideoIdFromLocator(`https://www.youtube.com/watch?v=${videoId}&feature=share`), videoId);
  assert.equal(youtubeVideoIdFromLocator(`https://youtu.be/${videoId}?t=3`), videoId);
  assert.equal(youtubeVideoIdFromLocator(`https://example.com/watch?v=${videoId}`), undefined);
  assert.equal(youtubeVideoIdFromLocator("not-a-url"), undefined);
});

test("the direct hint ignores pre-boundary and other-attempt receipts", () => {
  const attempt = {
    attemptId: "attempt:youtube:1",
    intentId: "intent:youtube:1",
    browserIdentityId: "identity:youtube:1",
    releaseSha: "sha",
    startedAt: "2026-09-05T10:00:00.000Z",
    finishedAt: "2026-09-05T10:00:10.000Z",
    result: "published",
    mediaSha256: "media",
    preparationArtifactRefs: [],
    reachedFinalActionBoundary: true,
    finalActionInvokedAt: "2026-09-05T10:00:05.000Z"
  };
  const evidence = [
    { evidenceId: "pre", intentId: attempt.intentId, attemptId: attempt.attemptId, kind: "ui_receipt", observedAt: "2026-09-05T10:00:04.000Z", positive: true, locator: "https://studio.youtube.com/video/PRE12345/edit" },
    { evidenceId: "other", intentId: attempt.intentId, attemptId: "attempt:other", kind: "ui_receipt", observedAt: "2026-09-05T10:00:07.000Z", positive: true, locator: "https://studio.youtube.com/video/OTHER123/edit" },
    { evidenceId: "negative", intentId: attempt.intentId, attemptId: attempt.attemptId, kind: "ui_receipt", observedAt: "2026-09-05T10:00:08.000Z", positive: false, locator: "https://studio.youtube.com/video/NEG12345/edit" },
    { evidenceId: "post", intentId: attempt.intentId, attemptId: attempt.attemptId, kind: "ui_receipt", observedAt: "2026-09-05T10:00:06.000Z", positive: true, locator: "https://studio.youtube.com/video/POST1234/edit" }
  ];

  assert.deepEqual(directYoutubeHint(evidence, attempt), {
    videoId: "POST1234",
    sourceUrl: "https://studio.youtube.com/video/POST1234/edit"
  });
});

test("workspace reconciliation runs direct YouTube verification before the profile fallback", () => {
  const source = readFileSync(new URL("../src/adapters/runtime/workspace-surface-publisher.ts", import.meta.url).pathname, "utf8");
  const direct = source.indexOf("new DirectYoutubeVerificationCollector");
  const profile = source.indexOf("new WorkspaceProfileVerificationCollector");
  const reconciliation = source.indexOf("new ReconciliationService(this.control,[directYoutube,verification]");
  assert.ok(direct > 0, "direct YouTube collector must be composed");
  assert.ok(profile > direct, "profile verifier must remain as the fallback after direct verification");
  assert.ok(reconciliation > profile, "reconciliation must receive direct verifier first and profile verifier second");
});
