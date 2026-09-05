import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteControlPlaneStore } from "../dist/adapters/storage/sqlite.js";
import { SqliteOperatorStateStore } from "../dist/adapters/storage/sqlite-operator-state.js";
import { OperatorCommandService } from "../dist/application/operator-commands.js";
import { KillSwitchService } from "../dist/application/operations.js";

const actor = { type: "test", id: "r13-commands" };
const channels = [
  { key: "reels", name: "Reels", platform: "instagram", accountId: "account:instagram:reels" },
  { key: "clips", name: "Clips", platform: "tiktok", accountId: "account:tiktok:clips" }
];

function fakeScheduleCommands() {
  const calls = [];
  let item = { channelKey: "reels", channelName: "Reels", platform: "instagram", format: "reel", times: ["12:00"], capacity: 1 };
  const result = (beforeTimes) => ({ ...item, changed: true, beforeTimes });
  return {
    calls,
    service: {
      show() { return [item]; },
      async add(target, time) {
        calls.push(["add", target, time]);
        const before = [...item.times];
        item = { ...item, times: [...item.times, time].sort(), capacity: item.capacity + 1 };
        return result(before);
      },
      async remove(target, time) {
        calls.push(["remove", target, time]);
        const before = [...item.times];
        item = { ...item, times: item.times.filter((slot) => slot !== time), capacity: item.capacity - 1 };
        return result(before);
      },
      async capacity(target, desired) {
        calls.push(["capacity", target, desired]);
        const before = [...item.times];
        const additions = ["15:00", "20:00"].filter((slot) => !item.times.includes(slot));
        item = { ...item, times: [...item.times, ...additions.slice(0, Math.max(0, desired - item.times.length))].sort(), capacity: desired };
        return result(before);
      }
    }
  };
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "flerdvision-r13-cmd-"));
  const control = new SqliteControlPlaneStore(join(dir, "workspace.sqlite"));
  const operator = new SqliteOperatorStateStore(join(dir, "workspace.sqlite"));
  const schedule = fakeScheduleCommands();
  control.registerSocialAccount({ accountId: "account:instagram:reels", creatorId: "creator", platform: "instagram", expectedHandle: "reels_handle", enabled: true }, "2026-08-30T06:00:00Z", actor);
  control.registerBrowserIdentity({ identityId: "browser:instagram:reels", accountId: "account:instagram:reels", platform: "instagram", profileKey: "instagram/reels", expectedHandle: "reels_handle", enabled: true }, "2026-08-30T06:00:00Z", actor);
  control.recordSessionHealth({ checkId: "check-1", identityId: "browser:instagram:reels", checkedAt: "2026-08-30T06:30:00Z", state: "HEALTHY", expectedHandle: "reels_handle", observedHandle: "reels_handle" }, actor);
  const service = new OperatorCommandService({
    channels,
    stores: { control, state: { listAssets: () => [] }, pauses: operator },
    pauses: operator,
    killSwitches: new KillSwitchService(control),
    scheduleCommands: schedule.service,
    doctor: () => ({ schemaVersion: 1, checkedAt: "2026-08-30T07:00:00Z", workspaceId: "ws", ownerEmail: "x@y.z", releaseSha: "sha", overall: "WARN", checks: [{ key: "drive_auth", status: "FAIL", detail: "Run drive-auth" }, { key: "node", status: "PASS", detail: "ok" }], channels: [{ channelKey: "reels", platform: "instagram", accountId: "account:instagram:reels", identityId: "browser:instagram:reels", accountRegistered: true, identityRegistered: true, latestSessionState: "HEALTHY", sessionProbeCalibrated: true, routes: [{ routeId: "r", format: "reel", readyAssets: 1, surfaceStatus: "CALIBRATED", prepareOnlyPasses: 3, verificationPassed: true, releaseMatches: true, privateE2EPassed: true, cleanupPassedAfterPrivateE2E: true, blockers: [], readyForAutonomousPublish: true }] }] }),
    timeZone: "Europe/Vienna",
    clock: () => "2026-08-30T07:00:00.000Z"
  });
  return { dir, control, operator, schedule, service, close() { operator.close(); control.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }); } };
}

test("/pause and /fortsetzen manage the persisted pause per channel and globally", async () => {
  const f = fixture();
  try {
    assert.match(await f.service.execute("/pause reels"), /⏸️ Reels \(Instagram\) pausiert/);
    assert.equal(f.operator.getSchedulePause("account:instagram:reels")?.channelKey, "reels");
    assert.match(await f.service.execute("/pause alle"), /⏸️ ALLE Kanäle pausiert/);
    assert.equal(f.operator.getSchedulePause("*")?.channelKey, "alle");
    assert.match(await f.service.execute("/fortsetzen reels"), /▶️ Reels \(Instagram\) fortgesetzt/);
    assert.equal(f.operator.getSchedulePause("account:instagram:reels"), null);
    assert.match(await f.service.execute("/fortsetzen reels"), /war nicht pausiert/);
    assert.match(await f.service.execute("/pause"), /Kanal fehlt/);
    assert.match(await f.service.execute("/pause zzz"), /Unbekannter Kanal/);
  } finally { f.close(); }
});

test("/zeitplan /slot and /limit use one injected canonical schedule service", async () => {
  const f = fixture();
  try {
    assert.match(await f.service.execute("/zeitplan"), /🗓️ Zeitplan/);
    assert.match(await f.service.execute("/zeitplan"), /Reels · reel: 12:00 \(1\/Tag\)/);
    assert.match(await f.service.execute("/slot reels + 16:00"), /Slots: 12:00, 16:00/);
    assert.match(await f.service.execute("/slot reels - 12:00"), /Slots: 16:00/);
    assert.match(await f.service.execute("/limit reels 3"), /3 Slots\/Tag/);
    assert.deepEqual(f.schedule.calls, [
      ["add", "reels", "16:00"],
      ["remove", "reels", "12:00"],
      ["capacity", "reels", 3]
    ]);
    assert.match(await f.service.execute("/slot reels x 16:00"), /Verwendung/);
    assert.match(await f.service.execute("/limit reels nope"), /ganze Zahl/);
  } finally { f.close(); }
});

test("/stopp enables the kill switch and there is no chat path that disables one", async () => {
  const f = fixture();
  try {
    const reply = await f.service.execute("/stopp reels");
    assert.match(reply, /🛑 Kill-Switch AKTIVIERT/);
    assert.match(reply, /nur im Terminal/);
    const switches = f.control.listKillSwitches(true);
    assert.equal(switches.length, 1);
    assert.equal(switches[0].scopeType, "ACCOUNT");
    assert.equal(switches[0].scopeKey, "account:instagram:reels");
    await f.service.execute("/stopp alle");
    assert.equal(f.control.listKillSwitches(true).length, 2);
    for (const attempt of ["/stopp reels aus", "/fortsetzen reels", "/start", "/status"]) await f.service.execute(attempt);
    assert.equal(f.control.listKillSwitches(true).length, 2);
  } finally { f.close(); }
});

test("/status reports sessions, pauses and kill switches per channel in German", async () => {
  const f = fixture();
  try {
    await f.service.execute("/pause clips");
    await f.service.execute("/stopp reels");
    const text = await f.service.execute("/status");
    assert.match(text, /📊 Status · So 30\. Aug/);
    assert.match(text, /✅ Reels \(Instagram\) · angemeldet · 🛑 Kill-Switch/);
    assert.match(text, /⚠️ Clips \(TikTok\) · nicht eingerichtet · ⏸️ pausiert/);
    assert.match(text, /Heute: 0 von 0 geplanten Posts sind live/);
    assert.doesNotMatch(text, /Offene Störungen/);
  } finally { f.close(); }
});

test("/plan, /doctor and help answer read-only and unknown commands point to help", async () => {
  const f = fixture();
  try {
    assert.match(await f.service.execute("/plan"), /📋 Tagesplan So 30\. Aug/);
    const doctorText = await f.service.execute("/doctor");
    assert.match(doctorText, /⚠️ Doctor · Gesamt: Warnung/);
    assert.match(doctorText, /Release sha/);
    assert.match(doctorText, /🛑 Google-Drive-Zugang: Fehler/);
    assert.match(doctorText, /✅ Reels · angemeldet · 1\/1 Routen bereit/);
    assert.doesNotMatch(doctorText, /Node-Version/);
    assert.match(await f.service.execute("/hilfe"), /gibt keinen Publish frei/);
    assert.match(await f.service.execute("was geht"), /Unbekannter Befehl/);
    assert.match(await f.service.execute("/status@FlerdvisionBot"), /📊 Status/);
  } finally { f.close(); }
});

test("a failing doctor probe answers with an error instead of throwing into the loop", async () => {
  const f = fixture();
  try {
    const failing = new OperatorCommandService({
      channels,
      stores: { control: f.control, state: { listAssets: () => [] }, pauses: f.operator },
      pauses: f.operator,
      killSwitches: new KillSwitchService(f.control),
      doctor: () => { throw new Error("spec missing"); },
      timeZone: "Europe/Vienna",
      clock: () => "2026-08-30T07:00:00.000Z"
    });
    assert.match(await failing.execute("/doctor"), /🛑 Doctor fehlgeschlagen: spec missing/);
    assert.match(await failing.execute("/zeitplan"), /nicht verbunden/);
  } finally { f.close(); }
});
