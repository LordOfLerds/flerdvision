import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteControlPlaneStore } from "../dist/adapters/storage/sqlite.js";
import { SqliteOperatorStateStore } from "../dist/adapters/storage/sqlite-operator-state.js";
import { CompositeOperationalPublishGate, SchedulePauseGate } from "../dist/application/schedule-pause.js";
import { KillSwitchGate, KillSwitchService, OperationalKillSwitchError } from "../dist/application/operations.js";
import { PublicationScheduler, DueWorkClaimer } from "../dist/application/scheduler.js";

// R13: /pause and /fortsetzen hold a channel's schedule without touching kill switches. The due
// worker must respect the persisted pause through its existing gate seam: paused due intents stay
// SCHEDULED and unclaimed, and resume makes them claimable again -- no state was burned.

const actor = { type: "test", id: "r13-pause" };

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), "flerdvision-r13-pause-"));
  return { dir, path: join(dir, "workspace.sqlite") };
}

function intent(intentId, accountId = "account:instagram:reels") {
  return {
    intentId, contentId: `content:${intentId}`, creatorId: "creator:test", platform: "instagram", accountId,
    format: "reel", copyVersionId: "copy:v1", scheduledFor: "2026-08-30T07:00:00Z", idempotencyKey: `idem:${intentId}`
  };
}

function scheduleIntent(store, intentId, accountId) {
  store.createOrGetIntent(intent(intentId, accountId), "2026-08-30T06:45:00Z", actor);
  store.transitionIntent(intentId, "READY", "2026-08-30T06:46:00Z", actor);
  new PublicationScheduler(store).scheduleIntent(intentId, "2026-08-30T06:47:00Z", actor);
}

test("pause gate blocks the paused account and the global pause blocks everything", () => {
  const runtime = tempDb();
  const operator = new SqliteOperatorStateStore(runtime.path);
  try {
    const gate = new SchedulePauseGate(operator);
    assert.equal(gate.evaluate(intent("i1")).allowed, true);
    operator.setSchedulePause({ scopeKey: "account:instagram:reels", channelKey: "reels", reason: "operator_pause", pausedAt: "2026-08-30T07:00:00Z", pausedBy: "op" });
    const decision = gate.evaluate(intent("i1"));
    assert.equal(decision.allowed, false);
    assert.equal(decision.blockingSwitches[0].scopeType, "ACCOUNT");
    assert.match(decision.blockingSwitches[0].reason, /^operator_pause:/);
    assert.equal(gate.evaluate(intent("i2", "account:tiktok:clips")).allowed, true);
    operator.setSchedulePause({ scopeKey: "*", channelKey: "alle", reason: "alarm", pausedAt: "2026-08-30T07:01:00Z", pausedBy: "op" });
    assert.equal(gate.evaluate(intent("i2", "account:tiktok:clips")).allowed, false);
    assert.throws(() => gate.assertAllowed(intent("i1")), OperationalKillSwitchError);
  } finally { operator.close(); rmSync(runtime.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }); }
});

test("composite gate merges kill-switch and pause blockers and needs at least one gate", () => {
  const runtime = tempDb();
  const control = new SqliteControlPlaneStore(runtime.path);
  const operator = new SqliteOperatorStateStore(runtime.path);
  try {
    assert.throws(() => new CompositeOperationalPublishGate([]), /at least one/);
    const gate = new CompositeOperationalPublishGate([new KillSwitchGate(control), new SchedulePauseGate(operator)]);
    assert.equal(gate.evaluate(intent("i1")).allowed, true);
    new KillSwitchService(control).set("PLATFORM", "instagram", true, "test stop", "2026-08-30T07:00:00Z", "op");
    operator.setSchedulePause({ scopeKey: "account:instagram:reels", channelKey: "reels", reason: "hold", pausedAt: "2026-08-30T07:00:00Z", pausedBy: "op" });
    const decision = gate.evaluate(intent("i1"));
    assert.equal(decision.allowed, false);
    assert.equal(decision.blockingSwitches.length, 2);
    const reasons = decision.blockingSwitches.map((item) => item.reason).sort();
    assert.match(reasons[0], /operator_pause:hold/);
    assert.equal(reasons[1], "test stop");
  } finally { operator.close(); control.close(); rmSync(runtime.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }); }
});

test("due worker leaves paused due intents SCHEDULED and claims them again after resume", () => {
  const runtime = tempDb();
  const control = new SqliteControlPlaneStore(runtime.path);
  const operator = new SqliteOperatorStateStore(runtime.path);
  try {
    scheduleIntent(control, "intent:paused");
    const reservation = control.getReservationForIntent("intent:paused");
    const dueNow = reservation.targetAt;
    const claimer = new DueWorkClaimer(control, new CompositeOperationalPublishGate([new KillSwitchGate(control), new SchedulePauseGate(operator)]));

    operator.setSchedulePause({ scopeKey: "account:instagram:reels", channelKey: "reels", reason: "operator_pause", pausedAt: "2026-08-30T06:50:00Z", pausedBy: "op" });
    assert.equal(claimer.claimNext("worker:r13", dueNow, 900), null);
    assert.equal(control.getIntent("intent:paused").state, "SCHEDULED");

    assert.equal(operator.clearSchedulePause("account:instagram:reels"), true);
    const claim = claimer.claimNext("worker:r13", dueNow, 900);
    assert.equal(claim.record.intent.intentId, "intent:paused");
    assert.equal(control.getIntent("intent:paused").state, "PREPARING");
  } finally { operator.close(); control.close(); rmSync(runtime.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }); }
});
