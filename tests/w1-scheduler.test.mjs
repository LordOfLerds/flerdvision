import test from "node:test";
import assert from "node:assert/strict";
import { SqliteControlPlaneStore } from "../dist/adapters/storage/sqlite.js";
import { PublicationScheduler, DueWorkClaimer, MissedWindowGuard } from "../dist/application/scheduler.js";
import {
  DEFAULT_SCHEDULING_POLICY,
  SchedulingPolicyError,
  instantForLocalDateTime
} from "../dist/domain/scheduling.js";

const actor = { type: "test", id: "scheduler-test" };
const createAt = "2026-08-26T05:00:00.000Z";

function addReady(store, id, scheduledFor, accountId = "ig-account") {
  store.createOrGetIntent({
    intentId: id,
    contentId: `content-${id}`,
    creatorId: "creator",
    platform: "instagram",
    accountId,
    format: "reel",
    copyVersionId: "copy-1",
    scheduledFor,
    idempotencyKey: `idem-${accountId}-${scheduledFor}`
  }, createAt, actor);
  store.transitionIntent(id, "READY", createAt, actor, "fixture_ready");
}

test("Europe/Vienna local slot conversion is DST-correct", () => {
  assert.equal(instantForLocalDateTime("2026-03-29", "09:00", "Europe/Vienna"), "2026-03-29T07:00:00.000Z");
  assert.equal(instantForLocalDateTime("2026-10-25", "09:00", "Europe/Vienna"), "2026-10-25T08:00:00.000Z");
});

test("canonical 09/11/15/17 slots schedule with explicit daily cap", () => {
  const store = new SqliteControlPlaneStore(":memory:");
  try {
    const scheduler = new PublicationScheduler(store);
    for (const [index, time] of ["09:00", "11:00", "15:00", "17:00"].entries()) {
      const id = `intent-${index + 1}`;
      addReady(store, id, instantForLocalDateTime("2026-08-26", time, "Europe/Vienna"));
      scheduler.scheduleIntent(id, createAt, actor);
    }
    assert.equal(store.listReservations("ig-account", "2026-08-26").length, 4);
    assert.equal(store.listIntents(["SCHEDULED"]).length, 4);
  } finally {
    store.close();
  }
});

test("daily cap remains enforced even if a future policy exposes more slots", () => {
  const store = new SqliteControlPlaneStore(":memory:");
  try {
    const policy = {
      ...DEFAULT_SCHEDULING_POLICY,
      slots: [...DEFAULT_SCHEDULING_POLICY.slots, { key: "slot-5", localTime: "19:00" }],
      minimumSpacingMinutes: 60,
      maxPerAccountPerBusinessDate: 4
    };
    const scheduler = new PublicationScheduler(store, policy);
    const times = ["09:00", "11:00", "15:00", "17:00", "19:00"];
    times.forEach((time, i) => addReady(store, `intent-${i + 1}`, instantForLocalDateTime("2026-08-26", time, "Europe/Vienna")));
    for (let i = 1; i <= 4; i += 1) scheduler.scheduleIntent(`intent-${i}`, createAt, actor);
    assert.throws(() => scheduler.scheduleIntent("intent-5", createAt, actor), SchedulingPolicyError);
  } finally {
    store.close();
  }
});

test("due work is leased and moved to PREPARING exactly once", () => {
  const store = new SqliteControlPlaneStore(":memory:");
  try {
    const target = instantForLocalDateTime("2026-08-26", "09:00", "Europe/Vienna");
    addReady(store, "intent-due", target);
    new PublicationScheduler(store).scheduleIntent("intent-due", createAt, actor);
    const claimer = new DueWorkClaimer(store);
    const claimed = claimer.claimNext("worker-a", target, 120);
    assert.equal(claimed?.record.state, "PREPARING");
    assert.equal(claimer.claimNext("worker-b", target, 120), null);
  } finally {
    store.close();
  }
});

test("a missed window inside the catch-up grace period is left SCHEDULED, not waived", () => {
  const store = new SqliteControlPlaneStore(":memory:");
  try {
    const target = instantForLocalDateTime("2026-08-26", "09:00", "Europe/Vienna");
    addReady(store, "intent-late", target);
    new PublicationScheduler(store).scheduleIntent("intent-late", createAt, actor);
    const afterWindow = "2026-08-26T07:31:00.000Z"; // 09:31 Vienna, 31min late, well inside the 4h default catch-up
    const waived = new MissedWindowGuard(store).waiveMissed(afterWindow, actor);
    assert.deepEqual(waived, []);
    assert.equal(store.getIntent("intent-late")?.state, "SCHEDULED");
    assert.equal(store.listDueReservations(afterWindow).length, 0);
  } finally {
    store.close();
  }
});

test("a missed window past the catch-up deadline is WAIVED with the fixed reason", () => {
  const store = new SqliteControlPlaneStore(":memory:");
  try {
    const target = instantForLocalDateTime("2026-08-26", "09:00", "Europe/Vienna");
    addReady(store, "intent-late", target);
    new PublicationScheduler(store).scheduleIntent("intent-late", createAt, actor);
    const pastCatchUp = "2026-08-26T13:01:00.000Z"; // 09:00 Vienna + 4h01
    const waived = new MissedWindowGuard(store).waiveMissed(pastCatchUp, actor);
    assert.deepEqual(waived, ["intent-late"]);
    assert.equal(store.getIntent("intent-late")?.state, "WAIVED");
    const events = store.listEvents("publication_intent", "intent-late");
    const waivedEvent = [...events].reverse().find((event) => event.toState === "WAIVED");
    assert.equal(waivedEvent?.payload.reason, "Slot verpasst, Nachholfenster abgelaufen");
    // Idempotent: a second sweep at the same instant finds nothing left to waive.
    assert.deepEqual(new MissedWindowGuard(store).waiveMissed(pastCatchUp, actor), []);
  } finally {
    store.close();
  }
});

test("a configured catchUpHours changes the waive deadline", () => {
  const store = new SqliteControlPlaneStore(":memory:");
  try {
    const shortCatchUp = { ...DEFAULT_SCHEDULING_POLICY, catchUpHours: 1 };
    const target = instantForLocalDateTime("2026-08-26", "09:00", "Europe/Vienna");
    addReady(store, "intent-late", target);
    new PublicationScheduler(store).scheduleIntent("intent-late", createAt, actor);
    const after90Minutes = "2026-08-26T08:31:00.000Z"; // 09:00 Vienna + 1h31, past a 1h catch-up
    const waived = new MissedWindowGuard(store, shortCatchUp).waiveMissed(after90Minutes, actor);
    assert.deepEqual(waived, ["intent-late"]);
    assert.equal(store.getIntent("intent-late")?.state, "WAIVED");
  } finally {
    store.close();
  }
});

test("an overdue never-attempted intent is claimable via catch-up until the deadline", () => {
  const store = new SqliteControlPlaneStore(":memory:");
  try {
    const target = instantForLocalDateTime("2026-08-26", "09:00", "Europe/Vienna");
    addReady(store, "intent-late", target);
    new PublicationScheduler(store).scheduleIntent("intent-late", createAt, actor);
    const outageOver = "2026-08-26T09:00:00.000Z"; // 11:00 Vienna, 2h after target, inside the 4h default
    const claim = new DueWorkClaimer(store).claimNext("worker-a", outageOver, 120);
    assert.equal(claim?.record.intent.intentId, "intent-late");
    assert.equal(claim?.record.state, "PREPARING");
  } finally {
    store.close();
  }
});

test("an attempted (prepared) intent is never claimed a second time during catch-up", () => {
  const store = new SqliteControlPlaneStore(":memory:");
  try {
    const target = instantForLocalDateTime("2026-08-26", "09:00", "Europe/Vienna");
    addReady(store, "intent-late", target);
    new PublicationScheduler(store).scheduleIntent("intent-late", createAt, actor);
    // Simulate an interrupted attempt: prepared, then the worker crashed and the safe-rollback
    // path put the intent back to SCHEDULED -- the attempt record itself must still block re-claim.
    store.registerSocialAccount({ accountId: "ig-account", platform: "instagram", expectedHandle: "ig-account", enabled: true }, createAt, actor);
    store.registerBrowserIdentity({ identityId: "browser-1", accountId: "ig-account", platform: "instagram", profileKey: "ig/ig-account", expectedHandle: "ig-account", enabled: true }, createAt, actor);
    store.recordPreparedAttempt({
      attemptId: "attempt-1", intentId: "intent-late", browserIdentityId: "browser-1",
      releaseSha: "release-1", startedAt: target, result: "prepared", reachedFinalActionBoundary: true
    }, actor);
    const outageOver = "2026-08-26T09:00:00.000Z"; // 2h after target, inside the 4h catch-up
    assert.equal(new DueWorkClaimer(store).claimNext("worker-a", outageOver, 120), null);
    // ...and once catch-up itself expires it is waived like any other stuck SCHEDULED intent.
    const pastCatchUp = "2026-08-26T13:01:00.000Z";
    assert.deepEqual(new MissedWindowGuard(store).waiveMissed(pastCatchUp, actor), ["intent-late"]);
  } finally {
    store.close();
  }
});

test("earliest overdue intent for an account is caught up before a later one", () => {
  const store = new SqliteControlPlaneStore(":memory:");
  try {
    const early = instantForLocalDateTime("2026-08-26", "09:00", "Europe/Vienna");
    const late = instantForLocalDateTime("2026-08-26", "11:00", "Europe/Vienna");
    addReady(store, "intent-early", early);
    addReady(store, "intent-late", late);
    const scheduler = new PublicationScheduler(store);
    scheduler.scheduleIntent("intent-early", createAt, actor);
    scheduler.scheduleIntent("intent-late", createAt, actor);
    const outageOver = "2026-08-26T10:05:00.000Z"; // 12:05 Vienna: both windows missed, both inside catch-up
    const claimer = new DueWorkClaimer(store);
    const first = claimer.claimNext("worker-a", outageOver, 120);
    assert.equal(first?.record.intent.intentId, "intent-early");
    const second = claimer.claimNext("worker-a", outageOver, 120);
    assert.equal(second?.record.intent.intentId, "intent-late");
  } finally {
    store.close();
  }
});

test("a kill switch blocks catch-up exactly like an on-time claim", () => {
  const store = new SqliteControlPlaneStore(":memory:");
  try {
    const target = instantForLocalDateTime("2026-08-26", "09:00", "Europe/Vienna");
    addReady(store, "intent-late", target);
    new PublicationScheduler(store).scheduleIntent("intent-late", createAt, actor);
    const outageOver = "2026-08-26T09:00:00.000Z";
    const blockingGate = { evaluate: () => ({ allowed: false, blockingSwitches: [{ scopeType: "GLOBAL", scopeKey: "*" }] }) };
    const claim = new DueWorkClaimer(store, blockingGate).claimNext("worker-a", outageOver, 120);
    assert.equal(claim, null);
    assert.equal(store.getIntent("intent-late")?.state, "SCHEDULED");
  } finally {
    store.close();
  }
});
