import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findLatestRecording } from "../dist/adapters/browser/prepare-artifacts.js";
import { publicationOutcomeMessage } from "../dist/application/publication-notifications.js";

// Recordings remain available as internal diagnostic evidence. Telegram success outcomes are
// screenshot-only; a recording may travel only with an uncertain/failed outcome.
const src = (rel) => readFileSync(new URL(rel, import.meta.url).pathname, "utf8");

test("the newest screencast beside an intent's evidence is found, and nothing else", () => {
  const root = join(tmpdir(), `fv-rec-${Date.now()}`);
  const dir = join(root, "intent_a1"); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "screencast-prepare-instagram.mp4"), "x");
  writeFileSync(join(dir, "screencast-surface-replay-instagram.mp4"), "y");
  writeFileSync(join(dir, "shot.png"), "z");
  utimesSync(join(dir, "screencast-prepare-instagram.mp4"), new Date(Date.now() + 5000), new Date(Date.now() + 5000));
  assert.match(findLatestRecording(root, "intent:a1"), /screencast-prepare-instagram\.mp4$/);
  assert.equal(findLatestRecording(root, "intent:none"), undefined);
});

test("verified outcome keeps its screenshot and drops the run video", () => {
  const intent = { intentId: "intent:i1", contentId: "c", creatorId: "cr", platform: "instagram", accountId: "account:instagram:x", format: "reel", copyVersionId: "v", scheduledFor: "2026-09-03T07:30:00.000Z", idempotencyKey: "k" };
  const message = publicationOutcomeMessage({ intent, runId: "r", outcome: "VERIFIED", screenshotPath: "/e/final.png", videoPath: "/e/run.mp4" }, "2026-09-03T08:00:00.000Z");
  assert.equal(message.metadata.screenshotPath, "/e/final.png");
  assert.equal(message.metadata.videoPath, undefined);
});

test("an uncertain outcome may still carry diagnostic video evidence", () => {
  const intent = { intentId: "intent:i2", contentId: "c", creatorId: "cr", platform: "youtube", accountId: "account:youtube:x", format: "short", copyVersionId: "v", scheduledFor: "2026-09-03T08:30:00.000Z", idempotencyKey: "k2" };
  const message = publicationOutcomeMessage({ intent, runId: "r", outcome: "UNCERTAIN", screenshotPath: "/e/failure.png", videoPath: "/e/run.mp4" }, "2026-09-03T09:00:00.000Z");
  assert.equal(message.metadata.screenshotPath, "/e/failure.png");
  assert.equal(message.metadata.videoPath, "/e/run.mp4");
});

test("the daemon and the private E2E both keep diagnostic recording lookup available", () => {
  assert.match(src("../src/application/headless-autonomous-runtime.ts"), /findRecording: \(intent: PublicationIntent\) => findLatestRecording\(/);
  assert.match(src("../src/adapters/runtime/workspace-private-e2e.ts"), /findLatestRecording\(resolve\(this\.layout\.evidenceDir,"publisher"\),record\.intent\.intentId\)/);
});
