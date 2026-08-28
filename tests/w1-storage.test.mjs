import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  IdempotencyConflictError,
  SqliteControlPlaneStore
} from "../dist/adapters/storage/sqlite.js";

const actor = { type: "test", id: "storage-test" };
const now = "2026-08-26T06:00:00.000Z";

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), "flerdvision-w1-"));
  return { dir, db: join(dir, "control.sqlite") };
}

function intent(overrides = {}) {
  return {
    intentId: "intent-1",
    contentId: "content-1",
    creatorId: "creator-1",
    platform: "instagram",
    accountId: "ig-creator-1",
    format: "reel",
    copyVersionId: "copy-1",
    scheduledFor: "2026-08-26T07:00:00.000Z",
    idempotencyKey: "idem-creator-1-instagram-2026-08-26-slot-1",
    ...overrides
  };
}

test("SQLite intent creation is idempotent and survives reopen", () => {
  const { dir, db } = tempDb();
  try {
    let store = new SqliteControlPlaneStore(db);
    const first = store.createOrGetIntent(intent(), now, actor);
    assert.equal(first.created, true);
    store.transitionIntent("intent-1", "READY", now, actor, "fixture_ready");
    store.close();

    store = new SqliteControlPlaneStore(db);
    const duplicate = store.createOrGetIntent(intent({ intentId: "a-new-random-id" }), now, actor);
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.record.intent.intentId, "intent-1");
    assert.equal(store.listIntents().length, 1);
    assert.equal(store.getIntent("intent-1")?.state, "READY");
    assert.equal(store.listEvents("publication_intent", "intent-1").length, 2);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
  }
});

test("same idempotency key with different payload fails closed", () => {
  const store = new SqliteControlPlaneStore(":memory:");
  try {
    store.createOrGetIntent(intent(), now, actor);
    assert.throws(
      () => store.createOrGetIntent(intent({ intentId: "intent-2", accountId: "wrong-account" }), now, actor),
      IdempotencyConflictError
    );
  } finally {
    store.close();
  }
});

test("event log is append-only at the SQLite layer", () => {
  const { dir, db } = tempDb();
  try {
    const store = new SqliteControlPlaneStore(db);
    store.createOrGetIntent(intent(), now, actor);
    store.close();

    const raw = new DatabaseSync(db);
    assert.throws(() => raw.exec("UPDATE event_log SET event_type = 'tampered' WHERE sequence = 1"), /append-only/);
    assert.throws(() => raw.exec("DELETE FROM event_log WHERE sequence = 1"), /append-only/);
    raw.close();
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
  }
});

test("worker leases prevent two workers owning the same publication intent", () => {
  const { dir, db } = tempDb();
  try {
    const a = new SqliteControlPlaneStore(db);
    const b = new SqliteControlPlaneStore(db);
    const leaseA = a.acquireLease("publication-intent:intent-1", "worker-a", now, 60, actor);
    assert.equal(leaseA?.ownerId, "worker-a");
    assert.equal(b.acquireLease("publication-intent:intent-1", "worker-b", now, 60, actor), null);

    const afterExpiry = "2026-08-26T06:01:01.000Z";
    const leaseB = b.acquireLease("publication-intent:intent-1", "worker-b", afterExpiry, 60, actor);
    assert.equal(leaseB?.ownerId, "worker-b");
    a.close();
    b.close();
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
  }
});
