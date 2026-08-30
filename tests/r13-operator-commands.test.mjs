import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteControlPlaneStore } from "../dist/adapters/storage/sqlite.js";
import { SqliteOperatorStateStore } from "../dist/adapters/storage/sqlite-operator-state.js";
import { OperatorCommandService } from "../dist/application/operator-commands.js";
import { KillSwitchService } from "../dist/application/operations.js";

// R13: chat commands are German, compact and hard-bounded. /stopp can only ENABLE a kill
// switch; there is deliberately no chat path that disables one (terminal only). /pause and
// /fortsetzen manage the persisted schedule pause the due worker respects.

const actor = { type: "test", id: "r13-commands" };
const channels = [
  { key: "reels", name: "Reels", platform: "instagram", accountId: "account:instagram:reels" },
  { key: "clips", name: "Clips", platform: "tiktok", accountId: "account:tiktok:clips" }
];

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "flerdvision-r13-cmd-"));
  const control = new SqliteControlPlaneStore(join(dir, "workspace.sqlite"));
  const operator = new SqliteOperatorStateStore(join(dir, "workspace.sqlite"));
  control.registerSocialAccount({ accountId: "account:instagram:reels", creatorId: "creator", platform: "instagram", expectedHandle: "reels_handle", enabled: true }, "2026-08-30T06:00:00Z", actor);
  control.registerBrowserIdentity({ identityId: "browser:instagram:reels", accountId: "account:instagram:reels", platform: "instagram", profileKey: "instagram/reels", expectedHandle: "reels_handle", enabled: true }, "2026-08-30T06:00:00Z", actor);
  control.recordSessionHealth({ checkId: "check-1", identityId: "browser:instagram:reels", checkedAt: "2026-08-30T06:30:00Z", state: "HEALTHY", expectedHandle: "reels_handle", observedHandle: "reels_handle" }, actor);
  const service = new OperatorCommandService({
    channels,
    stores: { control, state: { listAssets: () => [] }, pauses: operator },
    pauses: operator,
    killSwitches: new KillSwitchService(control),
    doctor: () => ({ schemaVersion: 1, checkedAt: "2026-08-30T07:00:00Z", workspaceId: "ws", ownerEmail: "x@y.z", releaseSha: "sha", overall: "WARN", checks: [{ key: "drive_auth", status: "FAIL", detail: "Run drive-auth" }, { key: "node", status: "PASS", detail: "ok" }], channels: [{ channelKey: "reels", platform: "instagram", accountId: "account:instagram:reels", identityId: "browser:instagram:reels", accountRegistered: true, identityRegistered: true, latestSessionState: "HEALTHY", sessionProbeCalibrated: true, routes: [{ routeId: "r", format: "reel", readyAssets: 1, surfaceStatus: "CALIBRATED", prepareOnlyPasses: 3, verificationPassed: true, releaseMatches: true, privateE2EPassed: true, cleanupPassedAfterPrivateE2E: true, blockers: [], readyForAutonomousPublish: true }] }] }),
    timeZone: "Europe/Vienna",
    clock: () => "2026-08-30T07:00:00.000Z"
  });
  return { dir, control, operator, service, close() { operator.close(); control.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }); } };
}

test("/pause and /fortsetzen manage the persisted pause per channel and globally", async () => {
  const f = fixture();
  try {
    assert.match(await f.service.execute("/pause reels"), /⏸️ Kanal reels \(instagram\) pausiert/);
    assert.equal(f.operator.getSchedulePause("account:instagram:reels")?.channelKey, "reels");
    assert.match(await f.service.execute("/pause alle"), /⏸️ ALLE Kanäle pausiert/);
    assert.equal(f.operator.getSchedulePause("*")?.channelKey, "alle");
    assert.match(await f.service.execute("/fortsetzen reels"), /▶️ Kanal reels \(instagram\) fortgesetzt/);
    assert.equal(f.operator.getSchedulePause("account:instagram:reels"), null);
    assert.match(await f.service.execute("/fortsetzen reels"), /war nicht pausiert/);
    assert.match(await f.service.execute("/pause"), /Kanal fehlt/);
    assert.match(await f.service.execute("/pause zzz"), /Unbekannter Kanal/);
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
    // Every command round-trips through the service; none of them can disable a switch.
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
    assert.match(text, /📊 Status · 2026-08-30/);
    assert.match(text, /✅ reels \(instagram\) · Session HEALTHY · 🛑 Kill-Switch/);
    assert.match(text, /⚠️ clips \(tiktok\) · Session MISSING · ⏸️ pausiert/);
    assert.match(text, /Heute: 0\/0 verifiziert/);
  } finally { f.close(); }
});

test("/plan, /doctor and help answer read-only and unknown commands point to help", async () => {
  const f = fixture();
  try {
    assert.match(await f.service.execute("/plan"), /📋 Tagesplan 2026-08-30/);
    const doctorText = await f.service.execute("/doctor");
    assert.match(doctorText, /⚠️ Doctor · ws · Gesamt: WARN/);
    assert.match(doctorText, /🛑 drive_auth: Run drive-auth/);
    assert.match(doctorText, /✅ reels: Session HEALTHY · 1\/1 Routen bereit/);
    assert.doesNotMatch(doctorText, /node: ok/);
    assert.match(await f.service.execute("/hilfe"), /Der Bot postet nie/);
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
  } finally { f.close(); }
});
