import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteOperatorStateStore } from "../dist/adapters/storage/sqlite-operator-state.js";

// R13: interactive Telegram operator layer (decision 2026-08-30). The operator's pause state,
// the per-day checklist message id and one-shot report/alarm marks must be durable across
// daemon restarts -- they live in the workspace database, in operator-owned tables.

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), "flerdvision-r13-state-"));
  return { dir, path: join(dir, "workspace.sqlite") };
}

test("schedule pauses persist across store reopen and clear idempotently", () => {
  const runtime = tempDb();
  let store = new SqliteOperatorStateStore(runtime.path);
  try {
    store.setSchedulePause({ scopeKey: "account:instagram:reels", channelKey: "reels", reason: "operator_pause", pausedAt: "2026-08-30T07:00:00Z", pausedBy: "telegram-operator" });
    store.setSchedulePause({ scopeKey: "*", channelKey: "alle", reason: "session_auth", pausedAt: "2026-08-30T07:01:00Z", pausedBy: "session-health-alarm" });
    store.close();
    store = new SqliteOperatorStateStore(runtime.path);
    assert.equal(store.listSchedulePauses().length, 2);
    assert.equal(store.getSchedulePause("account:instagram:reels")?.channelKey, "reels");
    assert.equal(store.getSchedulePause("*")?.reason, "session_auth");
    assert.equal(store.clearSchedulePause("*"), true);
    assert.equal(store.clearSchedulePause("*"), false);
    assert.equal(store.getSchedulePause("*"), null);
    assert.equal(store.listSchedulePauses().length, 1);
  } finally { store.close(); rmSync(runtime.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }); }
});

test("re-pausing a scope overwrites reason and timestamp instead of failing", () => {
  const runtime = tempDb();
  const store = new SqliteOperatorStateStore(runtime.path);
  try {
    store.setSchedulePause({ scopeKey: "account:tiktok:clips", channelKey: "clips", reason: "first", pausedAt: "2026-08-30T07:00:00Z", pausedBy: "op" });
    store.setSchedulePause({ scopeKey: "account:tiktok:clips", channelKey: "clips", reason: "second", pausedAt: "2026-08-30T08:00:00Z", pausedBy: "op" });
    const pause = store.getSchedulePause("account:tiktok:clips");
    assert.equal(pause?.reason, "second");
    assert.equal(pause?.pausedAt, "2026-08-30T08:00:00.000Z");
    assert.equal(store.listSchedulePauses().length, 1);
  } finally { store.close(); rmSync(runtime.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }); }
});

test("pause validation rejects empty scope or reason", () => {
  const runtime = tempDb();
  const store = new SqliteOperatorStateStore(runtime.path);
  try {
    assert.throws(() => store.setSchedulePause({ scopeKey: " ", channelKey: "x", reason: "r", pausedAt: "2026-08-30T07:00:00Z", pausedBy: "op" }), /scope key/);
    assert.throws(() => store.setSchedulePause({ scopeKey: "a", channelKey: "x", reason: " ", pausedAt: "2026-08-30T07:00:00Z", pausedBy: "op" }), /reason/);
  } finally { store.close(); rmSync(runtime.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }); }
});

test("checklist message record upserts per business date and survives reopen", () => {
  const runtime = tempDb();
  let store = new SqliteOperatorStateStore(runtime.path);
  try {
    assert.equal(store.getChecklistMessage("2026-08-30"), null);
    store.putChecklistMessage({ businessDate: "2026-08-30", chatMessageId: "101", contentHash: "h1", updatedAt: "2026-08-30T06:30:00Z" });
    store.putChecklistMessage({ businessDate: "2026-08-30", chatMessageId: "101", contentHash: "h2", updatedAt: "2026-08-30T09:30:00Z" });
    store.close();
    store = new SqliteOperatorStateStore(runtime.path);
    const record = store.getChecklistMessage("2026-08-30");
    assert.equal(record?.chatMessageId, "101");
    assert.equal(record?.contentHash, "h2");
    assert.equal(store.getChecklistMessage("2026-08-31"), null);
  } finally { store.close(); rmSync(runtime.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }); }
});

test("operator event marks are one-shot and durable", () => {
  const runtime = tempDb();
  let store = new SqliteOperatorStateStore(runtime.path);
  try {
    assert.equal(store.wasOperatorEventSent("morgen:2026-08-30"), false);
    assert.equal(store.markOperatorEventSent("morgen:2026-08-30", "2026-08-30T06:30:00Z"), true);
    assert.equal(store.markOperatorEventSent("morgen:2026-08-30", "2026-08-30T06:31:00Z"), false);
    store.close();
    store = new SqliteOperatorStateStore(runtime.path);
    assert.equal(store.wasOperatorEventSent("morgen:2026-08-30"), true);
  } finally { store.close(); rmSync(runtime.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }); }
});

test("operator tables do not collide with the control-plane store in the same database", async () => {
  const runtime = tempDb();
  const { SqliteControlPlaneStore } = await import("../dist/adapters/storage/sqlite.js");
  const control = new SqliteControlPlaneStore(runtime.path);
  const store = new SqliteOperatorStateStore(runtime.path);
  try {
    store.setSchedulePause({ scopeKey: "*", channelKey: "alle", reason: "test", pausedAt: "2026-08-30T07:00:00Z", pausedBy: "op" });
    assert.equal(control.listKillSwitches().length, 0);
    assert.equal(store.listSchedulePauses().length, 1);
  } finally { store.close(); control.close(); rmSync(runtime.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }); }
});
