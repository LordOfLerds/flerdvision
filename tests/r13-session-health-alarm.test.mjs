import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteControlPlaneStore } from "../dist/adapters/storage/sqlite.js";
import { SqliteOperatorStateStore } from "../dist/adapters/storage/sqlite-operator-state.js";
import { SessionHealthAlarmService } from "../dist/application/session-health-alarm.js";

// R13: AUTH_REQUIRED/CHALLENGE pauses the account BEFORE the alarm goes out, exactly one alarm
// per health check reaches the chat (with the noVNC link), and recovery is strictly human via
// /fortsetzen -- the service never unpauses anything on its own.

const actor = { type: "test", id: "r13-alarm" };
const channels = [{ key: "reels", name: "Reels", platform: "instagram", accountId: "account:instagram:reels" }];

function fixture(remoteScreenUrl = "https://vnc.example.invalid/session") {
  const dir = mkdtempSync(join(tmpdir(), "flerdvision-r13-alarm-"));
  const control = new SqliteControlPlaneStore(join(dir, "workspace.sqlite"));
  const operator = new SqliteOperatorStateStore(join(dir, "workspace.sqlite"));
  control.registerSocialAccount({ accountId: "account:instagram:reels", creatorId: "creator", platform: "instagram", expectedHandle: "reels_handle", enabled: true }, "2026-08-30T06:00:00Z", actor);
  control.registerBrowserIdentity({ identityId: "browser:instagram:reels", accountId: "account:instagram:reels", platform: "instagram", profileKey: "instagram/reels", expectedHandle: "reels_handle", enabled: true }, "2026-08-30T06:00:00Z", actor);
  const sent = [];
  const service = new SessionHealthAlarmService({
    control, channels, pauses: operator, chatState: operator,
    messenger: { sendMessage: async (text) => { sent.push(text); return String(sent.length); } },
    ...(remoteScreenUrl ? { remoteScreenUrl } : {}),
    clock: () => "2026-08-30T07:00:00.000Z"
  });
  const health = (checkId, state, checkedAt) => control.recordSessionHealth({ checkId, identityId: "browser:instagram:reels", checkedAt, state, expectedHandle: "reels_handle", ...(state === "HEALTHY" ? { observedHandle: "reels_handle" } : {}) }, actor);
  return { dir, control, operator, sent, service, health, close() { operator.close(); control.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }); } };
}

test("AUTH_REQUIRED pauses the channel and sends exactly one alarm per health check", async () => {
  const f = fixture();
  try {
    f.health("check-1", "AUTH_REQUIRED", "2026-08-30T06:55:00Z");
    const first = await f.service.tick();
    assert.deepEqual(first, { paused: 1, alarmsSent: 1 });
    const pause = f.operator.getSchedulePause("account:instagram:reels");
    assert.equal(pause.reason, "session_auth_required");
    assert.equal(pause.pausedBy, "session-health-alarm");
    assert.match(f.sent[0], /🛑 Re-Login nötig · Reels \(Instagram\)/);
    assert.match(f.sent[0], /Der Kanal ist abgemeldet\./);
    assert.match(f.sent[0], /https:\/\/vnc\.example\.invalid\/session/);
    assert.match(f.sent[0], /\/fortsetzen reels/);

    const second = await f.service.tick();
    assert.deepEqual(second, { paused: 0, alarmsSent: 0 });
    assert.equal(f.sent.length, 1);
  } finally { f.close(); }
});

test("recovery is human: HEALTHY never auto-resumes, and a new challenge alarms again", async () => {
  const f = fixture();
  try {
    f.health("check-1", "AUTH_REQUIRED", "2026-08-30T06:55:00Z");
    await f.service.tick();
    f.health("check-2", "HEALTHY", "2026-08-30T07:10:00Z");
    const healthy = await f.service.tick();
    assert.deepEqual(healthy, { paused: 0, alarmsSent: 0 });
    assert.ok(f.operator.getSchedulePause("account:instagram:reels"), "pause must survive until /fortsetzen");

    f.operator.clearSchedulePause("account:instagram:reels"); // operator ran /fortsetzen
    f.health("check-3", "CHALLENGE", "2026-08-30T08:00:00Z");
    const challenge = await f.service.tick();
    assert.deepEqual(challenge, { paused: 1, alarmsSent: 1 });
    assert.equal(f.operator.getSchedulePause("account:instagram:reels").reason, "session_challenge");
    assert.match(f.sent[1], /🛑 Sicherheits-Challenge · Reels \(Instagram\)/);
  } finally { f.close(); }
});

test("without a configured remote screen URL the alarm offers the login command instead", async () => {
  const f = fixture("");
  try {
    f.health("check-1", "CHALLENGE", "2026-08-30T06:55:00Z");
    await f.service.tick();
    // A dead link helps nobody; the operator gets the command that actually opens a login.
    assert.match(f.sent[0], /npm run flerdvision -- login --channel reels/);
    assert.doesNotMatch(f.sent[0], /FLERDVISION_REMOTE_SCREEN_URL/);
  } finally { f.close(); }
});

test("an operator pause set earlier is not overwritten by the alarm", async () => {
  const f = fixture();
  try {
    f.operator.setSchedulePause({ scopeKey: "account:instagram:reels", channelKey: "reels", reason: "operator_pause", pausedAt: "2026-08-30T06:00:00Z", pausedBy: "op" });
    f.health("check-1", "AUTH_REQUIRED", "2026-08-30T06:55:00Z");
    const result = await f.service.tick();
    assert.deepEqual(result, { paused: 0, alarmsSent: 1 });
    assert.equal(f.operator.getSchedulePause("account:instagram:reels").reason, "operator_pause");
  } finally { f.close(); }
});
