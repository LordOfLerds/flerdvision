import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteControlPlaneStore } from "../dist/adapters/storage/sqlite.js";
import { SqliteOperatorStateStore } from "../dist/adapters/storage/sqlite-operator-state.js";
import { TelegramOperatorService } from "../dist/application/telegram-operator-runtime.js";

// R13: one composition root wires command loop, checklist/reports, alarm and the pause-aware
// publish gate from the daemon's already-open stores. Credentials come only from the private
// env; without them the whole layer stays off. All Telegram traffic is faked.

const actor = { type: "test", id: "r13-runtime" };
const NOW = "2026-08-30T05:31:00.000Z"; // 07:31 Europe/Vienna, Sunday
const channels = [{ key: "reels", name: "Reels", platform: "instagram", accountId: "account:instagram:reels" }];

function fakeTelegram() {
  const calls = [];
  const updatesQueue = [];
  const fetchImpl = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : {};
    calls.push({ url, body });
    if (url.endsWith("/getUpdates")) return { ok: true, status: 200, json: async () => ({ ok: true, result: updatesQueue.shift() ?? [] }) };
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 500 + calls.length } }) };
  };
  return { calls, updatesQueue, fetchImpl };
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "flerdvision-r13-runtime-"));
  const control = new SqliteControlPlaneStore(join(dir, "workspace.sqlite"));
  const operatorState = new SqliteOperatorStateStore(join(dir, "workspace.sqlite"));
  control.registerSocialAccount({ accountId: "account:instagram:reels", creatorId: "creator", platform: "instagram", expectedHandle: "reels_handle", enabled: true }, "2026-08-30T05:00:00Z", actor);
  control.registerBrowserIdentity({ identityId: "browser:instagram:reels", accountId: "account:instagram:reels", platform: "instagram", profileKey: "instagram/reels", expectedHandle: "reels_handle", enabled: true }, "2026-08-30T05:00:00Z", actor);
  const telegram = fakeTelegram();
  const options = {
    env: { FLERDVISION_TELEGRAM_BOT_TOKEN: "tok", FLERDVISION_TELEGRAM_CHAT_ID: "777", FLERDVISION_REMOTE_SCREEN_URL: "https://vnc.example.invalid" },
    channels,
    control,
    state: { listAssets: () => [] },
    operatorState,
    doctor: () => { throw new Error("not needed here"); },
    timeZone: "Europe/Vienna",
    clock: () => NOW,
    fetchImpl: telegram.fetchImpl
  };
  const service = TelegramOperatorService.fromEnv(options);
  return { dir, control, operatorState, telegram, options, service, close() { operatorState.close(); control.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }); } };
}

test("fromEnv stays off without both credentials", () => {
  const f = fixture();
  try {
    assert.equal(TelegramOperatorService.fromEnv({ ...f.options, env: {} }), undefined);
    assert.equal(TelegramOperatorService.fromEnv({ ...f.options, env: { FLERDVISION_TELEGRAM_BOT_TOKEN: "tok" } }), undefined);
    assert.ok(f.service);
  } finally { f.close(); }
});

test("tick runs alarm and reports against the fake chat and contains telegram failures", async () => {
  const f = fixture();
  try {
    f.control.recordSessionHealth({ checkId: "check-1", identityId: "browser:instagram:reels", checkedAt: "2026-08-30T05:20:00Z", state: "AUTH_REQUIRED", expectedHandle: "reels_handle" }, actor);
    const result = await f.service.tick(NOW);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.alarm, { paused: 1, alarmsSent: 1 });
    assert.equal(result.reports.checklistSent, true);
    const texts = f.telegram.calls.filter((call) => call.url.endsWith("/sendMessage")).map((call) => call.body.text);
    assert.ok(texts.some((text) => text.includes("Re-Login nötig")));
    assert.ok(texts.some((text) => text.startsWith("📋 Tagesplan 2026-08-30")));
    assert.ok(f.operatorState.getSchedulePause("account:instagram:reels"));

    const broken = TelegramOperatorService.fromEnv({ ...f.options, fetchImpl: async () => { throw new Error("net down"); } });
    const failed = await broken.tick("2026-08-31T05:31:00Z");
    assert.equal(failed.errors.length >= 1, true);
  } finally { f.close(); }
});

test("command loop executes /pause from the allowlisted chat against the shared stores", async () => {
  const f = fixture();
  try {
    const nowSeconds = Math.floor(new Date(NOW).getTime() / 1000);
    f.telegram.updatesQueue.push([{ update_id: 1, message: { message_id: 1, date: nowSeconds, text: "/pause reels", chat: { id: 777 } } }]);
    const report = await f.service.pollCommandsOnce();
    assert.equal(report.handled, 1);
    assert.equal(f.operatorState.getSchedulePause("account:instagram:reels").channelKey, "reels");
    const reply = f.telegram.calls.filter((call) => call.url.endsWith("/sendMessage")).at(-1);
    assert.match(reply.body.text, /⏸️ Kanal reels \(instagram\) pausiert/);
  } finally { f.close(); }
});

test("publishGate combines kill switches with pauses for the due worker", async () => {
  const f = fixture();
  try {
    const intent = { intentId: "i1", contentId: "c1", creatorId: "c", platform: "instagram", accountId: "account:instagram:reels", format: "reel", copyVersionId: "v1", scheduledFor: NOW, idempotencyKey: "i1" };
    const gate = f.service.publishGate();
    assert.equal(gate.evaluate(intent).allowed, true);
    f.operatorState.setSchedulePause({ scopeKey: "account:instagram:reels", channelKey: "reels", reason: "hold", pausedAt: NOW, pausedBy: "op" });
    assert.equal(gate.evaluate(intent).allowed, false);
    f.operatorState.clearSchedulePause("account:instagram:reels");
    assert.equal(gate.evaluate(intent).allowed, true);
    const nowSeconds = Math.floor(new Date(NOW).getTime() / 1000);
    f.telegram.updatesQueue.push([{ update_id: 2, message: { message_id: 2, date: nowSeconds, text: "/stopp alle", chat: { id: 777 } } }]);
    await f.service.pollCommandsOnce();
    assert.equal(gate.evaluate(intent).allowed, false);
    assert.equal(f.control.listKillSwitches(true)[0].scopeType, "GLOBAL");
  } finally { f.close(); }
});
