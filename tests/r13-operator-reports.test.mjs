import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteOperatorStateStore } from "../dist/adapters/storage/sqlite-operator-state.js";
import { OperatorReportService } from "../dist/application/operator-reports.js";

// R13: morning checklist message that checks itself off via editMessageText as posts verify,
// one evening result report, one weekly report on Sundays -- all idempotent per business date
// and durable across daemon restarts (marks live in the operator state store). 2026-08-30 is
// a Sunday in Europe/Vienna.

const channels = [
  { key: "reels", name: "Reels", platform: "instagram", accountId: "account:instagram:reels" },
  { key: "clips", name: "Clips", platform: "tiktok", accountId: "account:tiktok:clips" }
];

function storedIntent(intentId, accountId, state, scheduledFor) {
  return {
    intent: { intentId, contentId: `content:${intentId}`, creatorId: "c", platform: "instagram", accountId, format: "reel", copyVersionId: "v1", scheduledFor, idempotencyKey: intentId },
    state, createdAt: scheduledFor, updatedAt: scheduledFor
  };
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "flerdvision-r13-report-"));
  const chatState = new SqliteOperatorStateStore(join(dir, "workspace.sqlite"));
  const intents = [
    storedIntent("i1", "account:instagram:reels", "SCHEDULED", "2026-08-30T07:30:00Z"),
    storedIntent("i2", "account:tiktok:clips", "SCHEDULED", "2026-08-30T15:00:00Z"),
    storedIntent("iLastWeek", "account:instagram:reels", "VERIFIED", "2026-08-26T07:30:00Z")
  ];
  const sent = [];
  const edited = [];
  const messenger = {
    sendMessage: async (text) => { sent.push(text); return String(100 + sent.length); },
    editMessageText: async (messageId, text) => { edited.push({ messageId, text }); }
  };
  const stores = {
    control: { listIntents: () => intents, getReservationForIntent: () => null, listIncidents: () => [], listKillSwitches: () => [] },
    state: { listAssets: () => [] },
    pauses: { listSchedulePauses: () => [] }
  };
  const service = new OperatorReportService({ stores, channels, chatState, messenger }, { timeZone: "Europe/Vienna" });
  return { dir, chatState, intents, sent, edited, messenger, stores, service, close() { chatState.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }); } };
}

test("morning checklist goes out once, then edits itself when a post verifies", async () => {
  const f = fixture();
  try {
    let result = await f.service.tick("2026-08-30T05:00:00Z"); // 07:00 local, before 07:30
    assert.deepEqual(result, { checklistSent: false, checklistEdited: false, eveningSent: false, weeklySent: false });
    assert.equal(f.sent.length, 0);

    result = await f.service.tick("2026-08-30T05:31:00Z"); // 07:31 local
    assert.equal(result.checklistSent, true);
    assert.equal(f.sent.length, 1);
    assert.match(f.sent[0], /📋 Tagesplan So 30\. Aug/);
    assert.match(f.sent[0], /⬜ 09:30 · Reels \(Instagram\) · „Video unbekannt“/);
    assert.equal(f.chatState.getChecklistMessage("2026-08-30").chatMessageId, "101");

    result = await f.service.tick("2026-08-30T06:00:00Z"); // unchanged plan -> no edit
    assert.deepEqual([result.checklistSent, result.checklistEdited], [false, false]);
    assert.equal(f.edited.length, 0);

    f.intents[0] = { ...f.intents[0], state: "VERIFIED" };
    result = await f.service.tick("2026-08-30T07:00:00Z");
    assert.equal(result.checklistEdited, true);
    assert.equal(f.edited.length, 1);
    assert.equal(f.edited[0].messageId, "101");
    assert.match(f.edited[0].text, /✅ 09:30 · Reels \(Instagram\)/);
    assert.equal(f.sent.length, 1); // never a second checklist message
  } finally { f.close(); }
});

test("a restarted service keeps editing the same persisted checklist message", async () => {
  const f = fixture();
  try {
    await f.service.tick("2026-08-30T05:31:00Z");
    f.intents[0] = { ...f.intents[0], state: "VERIFIED" };
    const restarted = new OperatorReportService({ stores: f.stores, channels, chatState: f.chatState, messenger: f.messenger }, { timeZone: "Europe/Vienna" });
    const result = await restarted.tick("2026-08-30T09:00:00Z");
    assert.equal(result.checklistSent, false);
    assert.equal(result.checklistEdited, true);
    assert.equal(f.edited[0].messageId, "101");
    assert.equal(f.sent.length, 1);
  } finally { f.close(); }
});

test("evening report once per day and the weekly report only on Sundays", async () => {
  const f = fixture();
  try {
    f.intents[0] = { ...f.intents[0], state: "VERIFIED" };
    const result = await f.service.tick("2026-08-30T18:31:00Z"); // 20:31 local, Sunday
    assert.equal(result.eveningSent, true);
    assert.equal(result.weeklySent, true);
    const evening = f.sent.find((text) => text.startsWith("🌙"));
    assert.match(evening, /🌙 Tagesabschluss · So 30\. Aug · ⚠️/);
    assert.match(evening, /✅ 1\/2 verifiziert/);
    assert.match(evening, /⚠️ Clips · „Video unbekannt“ · geplant/);
    const weekly = f.sent.find((text) => text.startsWith("📅"));
    assert.match(weekly, /📅 Wochenbericht · Mo 24\. Aug – So 30\. Aug/);
    assert.match(weekly, /✅ 2 verifiziert/);
    assert.match(weekly, /Reels: 2\/2 verifiziert/);
    assert.match(weekly, /Clips: 0\/1 verifiziert/);

    const again = await f.service.tick("2026-08-30T19:00:00Z");
    assert.deepEqual([again.eveningSent, again.weeklySent], [false, false]);
  } finally { f.close(); }
});

test("no weekly report on a Saturday", async () => {
  const f = fixture();
  try {
    const result = await f.service.tick("2026-08-29T18:31:00Z");
    assert.equal(result.eveningSent, true);
    assert.equal(result.weeklySent, false);
    assert.equal(f.sent.filter((text) => text.startsWith("📅")).length, 0);
  } finally { f.close(); }
});

test("a failed send is not marked and retries on the next cycle", async () => {
  const f = fixture();
  try {
    await f.service.tick("2026-08-30T05:31:00Z"); // checklist out
    let failures = 1;
    const original = f.messenger.sendMessage;
    f.messenger.sendMessage = async (text) => {
      if (failures > 0) { failures -= 1; throw new Error("telegram down"); }
      return original(text);
    };
    await assert.rejects(() => f.service.tick("2026-08-30T18:31:00Z"), /telegram down/);
    assert.equal(f.chatState.wasOperatorEventSent("abend:2026-08-30"), false);
    const retry = await f.service.tick("2026-08-30T18:40:00Z");
    assert.equal(retry.eveningSent, true);
    assert.equal(f.chatState.wasOperatorEventSent("abend:2026-08-30"), true);
  } finally { f.close(); }
});
