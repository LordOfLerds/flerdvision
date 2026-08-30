import test from "node:test";
import assert from "node:assert/strict";
import { jitterSeconds, seededRandom, humanPacing } from "../dist/adapters/browser/human-pacing.js";
import { DueWorkClaimer, PublicationScheduler } from "../dist/application/scheduler.js";
import { SqliteControlPlaneStore } from "../dist/adapters/storage/sqlite.js";
import { instantForLocalDateTime } from "../dist/domain/scheduling.js";

// Operator decision: posts scatter like a person, never machine-punctually at window start.
// The launch instant is target plus a deterministic per-intent offset, clamped two minutes
// before window end -- scatter can never become a missed window. Determinism is deliberate:
// identical runs replay identically and no wall-clock randomness enters the runtime.

const actor = { type: "system", id: "test" };
const target = instantForLocalDateTime("2026-08-31", "09:00", "Europe/Vienna");

function storeWithScheduled() {
  const store = new SqliteControlPlaneStore(":memory:");
  store.registerSocialAccount({ accountId: "acct", platform: "instagram", expectedHandle: "acct", enabled: true }, "2026-08-31T05:00:00Z", actor);
  store.createOrGetIntent({ intentId: "intent", contentId: "c", creatorId: "cr", platform: "instagram", accountId: "acct", format: "reel", copyVersionId: "v", scheduledFor: target, idempotencyKey: "k" }, "2026-08-31T05:00:02Z", actor);
  store.transitionIntent("intent", "READY", "2026-08-31T05:00:03Z", actor);
  new PublicationScheduler(store).scheduleIntent("intent", "2026-08-31T05:00:04Z", actor);
  return store;
}

test("jitter is deterministic per intent and bounded", () => {
  const a = jitterSeconds("intent:a", 480);
  assert.equal(a, jitterSeconds("intent:a", 480));
  assert.ok(a >= 0 && a <= 480);
  assert.notEqual(jitterSeconds("intent:a", 480), jitterSeconds("intent:b", 480));
  assert.equal(jitterSeconds("intent:a", 0), 0);
});

test("before the scattered launch instant nothing is claimed; after it the claim succeeds", () => {
  const store = storeWithScheduled();
  try {
    const claimer = new DueWorkClaimer(store);
    const offset = jitterSeconds("intent", 480);
    const beforeLaunch = new Date(new Date(target).getTime() + (offset - 1) * 1000).toISOString();
    const atLaunch = new Date(new Date(target).getTime() + offset * 1000).toISOString();
    if (offset > 0) assert.equal(claimer.claimNext("w", beforeLaunch, 300, undefined, 480), null);
    const claim = claimer.claimNext("w", atLaunch, 300, undefined, 480);
    assert.ok(claim, "claim must open exactly at the scattered launch instant");
  } finally { store.close(); }
});

test("the scatter clamps before window end and can never miss the window", () => {
  const store = storeWithScheduled();
  try {
    const claimer = new DueWorkClaimer(store);
    // Even with an absurd jitter budget, two minutes before window end the claim must open.
    const windowEndish = new Date(new Date(target).getTime() + 28 * 60_000).toISOString();
    const claim = claimer.claimNext("w", windowEndish, 300, undefined, 24 * 60 * 60);
    assert.ok(claim, "clamping must open the claim before the window closes");
  } finally { store.close(); }
});

test("human pacing is seeded: same seed same rhythm, different seed different rhythm", () => {
  const a = humanPacing("intent:a");
  const b = humanPacing("intent:a");
  const c = humanPacing("intent:c");
  assert.equal(a.stepPauseMs(), b.stepPauseMs());
  assert.notEqual(humanPacing("intent:a").stepPauseMs(), c.stepPauseMs());
  const delays = humanPacing("seed").typingDelaysMs("Hallo Welt");
  assert.equal(delays.length, "Hallo Welt".length);
  assert.ok(delays.every((ms) => ms >= 55 && ms <= 1300));
  assert.ok(seededRandom("x")() >= 0 && seededRandom("x")() < 1);
});
