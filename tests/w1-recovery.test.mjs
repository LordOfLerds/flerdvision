import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteControlPlaneStore } from "../dist/adapters/storage/sqlite.js";
import { PublicationScheduler, DueWorkClaimer } from "../dist/application/scheduler.js";
import { RestartRecoveryService } from "../dist/application/recovery.js";
import { instantForLocalDateTime } from "../dist/domain/scheduling.js";
import { canTransition } from "../dist/domain/states.js";

const actor = { type: "test", id: "recovery-test" };
const createAt = "2026-08-26T05:00:00.000Z";
const target = instantForLocalDateTime("2026-08-26", "09:00", "Europe/Vienna");

function readyAndSchedule(store, id) {
  store.createOrGetIntent({
    intentId: id,
    contentId: `content-${id}`,
    creatorId: "creator",
    platform: "instagram",
    accountId: `account-${id}`,
    format: "reel",
    copyVersionId: "copy",
    scheduledFor: target,
    idempotencyKey: `idem-${id}`
  }, createAt, actor);
  store.transitionIntent(id, "READY", createAt, actor);
  new PublicationScheduler(store).scheduleIntent(id, createAt, actor);
}

test("PUBLISH_UNCERTAIN cannot be retried without reconciliation", () => {
  assert.equal(canTransition("PUBLISH_UNCERTAIN", "READY"), false);
  assert.equal(canTransition("PUBLISH_UNCERTAIN", "VERIFYING"), true);
});

test("restart before final action safely rolls PREPARING back to SCHEDULED after lease expiry", () => {
  const store = new SqliteControlPlaneStore(":memory:");
  try {
    readyAndSchedule(store, "safe");
    new DueWorkClaimer(store).claimNext("worker-dead", target, 1);
    const afterLease = "2026-08-26T07:00:02.000Z";
    const report = new RestartRecoveryService(store).recover(afterLease);
    assert.deepEqual(report.safePrepareRollbacks, ["safe"]);
    assert.equal(store.getIntent("safe")?.state, "SCHEDULED");
  } finally {
    store.close();
  }
});

test("restart after irreversible boundary marks PUBLISHING uncertain, never ready", () => {
  const store = new SqliteControlPlaneStore(":memory:");
  try {
    readyAndSchedule(store, "unsafe");
    new DueWorkClaimer(store).claimNext("worker-dead", target, 1);
    store.transitionIntent("unsafe", "PUBLISHING", target, actor, "final_action_boundary_entered");
    const afterLease = "2026-08-26T07:00:02.000Z";
    const report = new RestartRecoveryService(store).recover(afterLease);
    assert.deepEqual(report.uncertainMarked, ["unsafe"]);
    assert.equal(store.getIntent("unsafe")?.state, "PUBLISH_UNCERTAIN");
  } finally {
    store.close();
  }
});

test("restart with still-active lease does not steal work from a live worker", () => {
  const store = new SqliteControlPlaneStore(":memory:");
  try {
    readyAndSchedule(store, "active");
    new DueWorkClaimer(store).claimNext("worker-live", target, 120);
    const report = new RestartRecoveryService(store).recover("2026-08-26T07:00:30.000Z");
    assert.deepEqual(report.skippedWithActiveLease, ["active"]);
    assert.equal(store.getIntent("active")?.state, "PREPARING");
  } finally {
    store.close();
  }
});

test("server restart plus duplicate intake still yields one durable intent", () => {
  const dir = mkdtempSync(join(tmpdir(), "flerdvision-restart-"));
  const db = join(dir, "control.sqlite");
  const original = {
    intentId: "stable",
    contentId: "content-stable",
    creatorId: "creator",
    platform: "instagram",
    accountId: "account",
    format: "reel",
    copyVersionId: "copy",
    scheduledFor: target,
    idempotencyKey: "same-logical-publication"
  };
  try {
    let store = new SqliteControlPlaneStore(db);
    store.createOrGetIntent(original, createAt, actor);
    store.close();

    store = new SqliteControlPlaneStore(db);
    const duplicate = store.createOrGetIntent({ ...original, intentId: "new-process-generated-id" }, createAt, actor);
    assert.equal(duplicate.created, false);
    assert.equal(store.listIntents().length, 1);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
  }
});
