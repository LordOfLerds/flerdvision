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

test("missed window blocks instead of catch-up publishing", () => {
  const store = new SqliteControlPlaneStore(":memory:");
  try {
    const target = instantForLocalDateTime("2026-08-26", "09:00", "Europe/Vienna");
    addReady(store, "intent-late", target);
    new PublicationScheduler(store).scheduleIntent("intent-late", createAt, actor);
    const afterWindow = "2026-08-26T07:31:00.000Z"; // 09:31 Vienna
    const blocked = new MissedWindowGuard(store).blockMissed(afterWindow, actor);
    assert.deepEqual(blocked, ["intent-late"]);
    assert.equal(store.getIntent("intent-late")?.state, "BLOCKED");
    assert.equal(store.listDueReservations(afterWindow).length, 0);
  } finally {
    store.close();
  }
});
