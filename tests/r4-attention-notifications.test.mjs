import test from "node:test";
import assert from "node:assert/strict";
import { notificationForAttention } from "../dist/application/attention-notifications.js";

const channels = [
  {
    key: "reels", name: "Reels", platform: "instagram", accountId: "account:instagram:reels",
    driveFolderUrl: "https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrS"
  }
];

test("attention notifications are quiet for INFO and deterministic for actionable states", () => {
  const info = notificationForAttention({
    attentionId: "a-info", severity: "INFO", kind: "BACKLOG", title: "Backlog", impact: "Moved", deepLink: "/content/x"
  }, "2026-08-27T06:00:00.000Z");
  assert.equal(info, null);

  const item = {
    attentionId: "a-critical", severity: "CRITICAL", kind: "ACCOUNT_SLOT_CONFLICT", title: "Slot conflict",
    impact: "Zwei Posts zielen auf denselben Slot.", accountId: "account:instagram:reels", routeId: "r1", deepLink: "/control-center/routes/r1"
  };
  const policy = { notify: { INFO: false, WARNING: true, ACTION_REQUIRED: true, CRITICAL: true }, channels };
  const first = notificationForAttention(item, "2026-08-27T06:00:00.000Z", policy);
  const second = notificationForAttention(item, "2026-08-27T06:00:00.000Z", policy);
  assert.deepEqual(first, second);
  assert.equal(first.severity, "CRITICAL");
  assert.equal(first.accountId, "account:instagram:reels");
  // The subject names the channel first: a notification list of "Etwas braucht deine
  // Aufmerksamkeit" told the operator nothing about which account was affected.
  assert.match(first.subject, /🚨 Reels \(Instagram\) · Zwei Posts zielen auf denselben Kanal zur selben Zeit/);
  assert.match(first.body, /Reels \(Instagram\)/);
  assert.match(first.body, /Was jetzt: Einen der beiden Slots verschieben\./);
});

test("the dead control-center deep link is gone from subject, body and metadata", () => {
  const message = notificationForAttention({
    attentionId: "a-route", severity: "ACTION_REQUIRED", kind: "ROUTE_BLOCKED", title: "Route blocked",
    impact: "Der Slot bleibt leer.", routeId: "r1", deepLink: "/control-center/routes/r1"
  }, "2026-08-27T06:00:00.000Z");
  const rendered = `${message.subject}\n${message.body}\n${JSON.stringify(message.metadata)}`;
  assert.doesNotMatch(rendered, /control-center/);
  assert.equal(message.metadata.deepLink, undefined);
});

test("a session problem offers the remote screen, and the login command when none is configured", () => {
  const item = {
    attentionId: "a-session", severity: "ACTION_REQUIRED", kind: "SESSION_UNHEALTHY", title: "Session",
    impact: "Es wird nichts veröffentlicht.", accountId: "account:instagram:reels", deepLink: "/control-center/x"
  };
  const notify = { INFO: false, WARNING: true, ACTION_REQUIRED: true, CRITICAL: true };
  const remote = notificationForAttention(item, "2026-08-27T06:00:00.000Z", { notify, channels, remoteScreenUrl: "https://vnc.example.invalid/session" });
  assert.match(remote.body, /Login im Remote-Browser: https:\/\/vnc\.example\.invalid\/session/);

  const terminal = notificationForAttention(item, "2026-08-27T06:00:00.000Z", { notify, channels });
  assert.match(terminal.body, /npm run flerdvision -- login --channel reels/);
});

test("a non-session attention never offers a login command", () => {
  const message = notificationForAttention({
    attentionId: "a-backlog", severity: "WARNING", kind: "NO_READY_CONTENT", title: "No content",
    impact: "Der Slot bleibt leer.", accountId: "account:instagram:reels", deepLink: "/control-center/x"
  }, "2026-08-27T06:00:00.000Z", { notify: { INFO: false, WARNING: true, ACTION_REQUIRED: true, CRITICAL: true }, channels });
  assert.doesNotMatch(message.body, /login --channel/);
  assert.match(message.body, /Was jetzt: Ein Video in den Drive-Ordner dieses Kanals legen/);
  // "Put a video in Drive" without the folder is a riddle; the channel's own folder is the answer.
  assert.match(message.body, /📁 Video hier ablegen: https:\/\/drive\.google\.com\/drive\/folders\/1AbCdEfGhIjKlMnOpQrS/);
});

test("a slot-bound attention names the wall-clock time in its subject", () => {
  const message = notificationForAttention({
    attentionId: "a-slot", severity: "ACTION_REQUIRED", kind: "PRE_SLOT_ESCALATION", title: "Kein Content",
    impact: "Der Slot ist gleich fällig.", accountId: "account:instagram:reels", slotKey: "reels-reel-1",
    slotLocalTime: "14:00", deepLink: "/routes/r1"
  }, "2026-08-27T06:00:00.000Z", { notify: { INFO: false, WARNING: true, ACTION_REQUIRED: true, CRITICAL: true }, channels });
  assert.match(message.subject, /🛑 14:00 · Reels \(Instagram\) · Ein Slot ist gleich fällig und noch ohne Video/);
});

test("an unknown attention kind falls back to its own title, never to a placeholder", () => {
  const message = notificationForAttention({
    attentionId: "a-unknown", severity: "WARNING", kind: "SOMETHING_NEW", title: "Der Kanal hat kein Zeitfenster",
    impact: "Heute wird für diesen Kanal nichts geplant.", accountId: "account:instagram:reels", deepLink: "/x"
  }, "2026-08-27T06:00:00.000Z", { notify: { INFO: false, WARNING: true, ACTION_REQUIRED: true, CRITICAL: true }, channels });
  assert.match(message.subject, /Der Kanal hat kein Zeitfenster/);
  assert.doesNotMatch(message.subject, /Aufmerksamkeit/);
  assert.doesNotMatch(`${message.subject}\n${message.body}`, /\/doctor/);
});

test("the autonomous runtime hands the attention path its channel names and remote screen", async () => {
  const { readFileSync } = await import("node:fs");
  const runtime = readFileSync(new URL("../src/application/headless-autonomous-runtime.ts", import.meta.url).pathname, "utf8");
  assert.match(runtime, /channels: operatorChannels/);
  const workspace = readFileSync(new URL("../src/adapters/runtime/workspace-distribution-runtime.ts", import.meta.url).pathname, "utf8");
  assert.match(workspace, /FLERDVISION_REMOTE_SCREEN_URL/);
  assert.doesNotMatch(workspace, /uiBaseUrl/);
});
