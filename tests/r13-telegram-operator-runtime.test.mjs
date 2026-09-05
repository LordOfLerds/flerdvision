import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteControlPlaneStore } from "../dist/adapters/storage/sqlite.js";
import { SqliteOperatorStateStore } from "../dist/adapters/storage/sqlite-operator-state.js";
import { TelegramOperatorService } from "../dist/application/telegram-operator-runtime.js";

const actor = { type: "test", id: "r13-runtime" };
const NOW = "2026-08-30T05:31:00.000Z";
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

function workspaceSpec(dir) {
  const source = join(dir, "source");
  const runtimeRoot = join(dir, "runtime");
  mkdirSync(source, { recursive: true });
  const path = join(dir, "flerdvision.json");
  writeFileSync(path, `${JSON.stringify({
    schemaVersion: 1,
    workspace: { id: "telegram-test", name: "Telegram Test", ownerEmail: "test@example.com", timezone: "Europe/Vienna", runtimeRoot },
    source: { kind: "local_folder", root: source, structure: "auto", activation: "NEW_ONLY", maxDepth: 4 },
    channels: [{
      key: "reels", name: "Reels", platform: "instagram", handle: "reels_handle",
      formats: [{ type: "reel", times: ["12:00"], sourceMatch: [], captionTemplate: "{filenameText}", hashtags: [], requirement: "REQUIRED", verificationMarker: false, settings: { commentsEnabled: true, shareToFeed: true, crosspostFacebook: false } }]
    }],
    notifications: { onSuccess: "daily_summary", onBlocked: "immediate", onUncertain: "immediate" },
    privateTest: { enabled: false, accountPrivate: false, approvedFollowers: 0, contactsSyncOff: false, crossPostingOff: false, autoCleanup: false }
  }, null, 2)}\n`);
  return path;
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "flerdvision-r13-runtime-"));
  const control = new SqliteControlPlaneStore(join(dir, "workspace.sqlite"));
  const operatorState = new SqliteOperatorStateStore(join(dir, "workspace.sqlite"));
  const specPath = workspaceSpec(dir);
  control.registerSocialAccount({ accountId: "account:instagram:reels", creatorId: "creator", platform: "instagram", expectedHandle: "reels_handle", enabled: true }, "2026-08-30T05:00:00Z", actor);
  control.registerBrowserIdentity({ identityId: "browser:instagram:reels", accountId: "account:instagram:reels", platform: "instagram", profileKey: "instagram/reels", expectedHandle: "reels_handle", enabled: true }, "2026-08-30T05:00:00Z", actor);
  const telegram = fakeTelegram();
  const options = {
    env: {
      FLERDVISION_TELEGRAM_BOT_TOKEN: "tok",
      FLERDVISION_TELEGRAM_CHAT_ID: "777",
      FLERDVISION_REMOTE_SCREEN_URL: "https://vnc.example.invalid",
      FLERDVISION_SPEC: specPath
    },
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
  return { dir, control, operatorState, telegram, options, service, specPath, close() { operatorState.close(); control.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }); } };
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
    assert.ok(texts.some((text) => text.startsWith("📋 Tagesplan So 30. Aug")));
    assert.ok(f.operatorState.getSchedulePause("account:instagram:reels"));

    const broken = TelegramOperatorService.fromEnv({ ...f.options, fetchImpl: async () => { throw new Error("net down"); } });
    const failed = await broken.tick("2026-08-31T05:31:00Z");
    assert.equal(failed.errors.length >= 1, true);
  } finally { f.close(); }
});

test("command loop executes pause and canonical schedule edits from the allowlisted chat", async () => {
  const f = fixture();
  try {
    const nowSeconds = Math.floor(new Date(NOW).getTime() / 1000);
    f.telegram.updatesQueue.push([{ update_id: 1, message: { message_id: 1, date: nowSeconds, text: "/pause reels", chat: { id: 777 } } }]);
    let report = await f.service.pollCommandsOnce();
    assert.equal(report.handled, 1);
    assert.equal(f.operatorState.getSchedulePause("account:instagram:reels").channelKey, "reels");

    f.telegram.updatesQueue.push([{ update_id: 2, message: { message_id: 2, date: nowSeconds, text: "/slot reels + 16:00", chat: { id: 777 } } }]);
    report = await f.service.pollCommandsOnce();
    assert.equal(report.handled, 1);
    const spec = JSON.parse(readFileSync(f.specPath, "utf8"));
    assert.deepEqual(spec.channels[0].formats[0].times, ["12:00", "16:00"]);
    const replies = f.telegram.calls.filter((call) => call.url.endsWith("/sendMessage")).map((call) => call.body.text);
    assert.ok(replies.some((text) => /Zeitplan aktualisiert/.test(text)));
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
    f.telegram.updatesQueue.push([{ update_id: 3, message: { message_id: 3, date: nowSeconds, text: "/stopp alle", chat: { id: 777 } } }]);
    await f.service.pollCommandsOnce();
    assert.equal(gate.evaluate(intent).allowed, false);
    assert.equal(f.control.listKillSwitches(true)[0].scopeType, "GLOBAL");
  } finally { f.close(); }
});

test("the Telegram runtime composes one canonical schedule service and the autonomous runtime keeps its composite gate", async () => {
  const runtime = readFileSync(new URL("../src/application/headless-autonomous-runtime.ts", import.meta.url).pathname, "utf8");
  const operator = readFileSync(new URL("../src/application/telegram-operator-runtime.ts", import.meta.url).pathname, "utf8");
  assert.match(operator, /new ScheduleCommandService\(specPath/);
  assert.match(operator, /bootstrapHeadlessWorkspace\(\{ specPath: path, env: options\.env \}\)/);
  assert.match(runtime, /TelegramOperatorService\.fromEnv\(/);
  assert.match(runtime, /operator \? operator\.publishGate\(\) : new KillSwitchGate\(base\.control\)/);
  assert.match(runtime, /await this\.operator\?\.tick\(\)\.catch\(\(\) => \{\}\)/);
  assert.match(runtime, /void this\.operator\.runCommandLoop\(loopSignal\)/);
  assert.match(runtime, /this\.operatorState\?\.close\(\)/);
});
