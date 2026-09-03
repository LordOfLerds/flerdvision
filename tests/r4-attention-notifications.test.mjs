import test from "node:test";
import assert from "node:assert/strict";
import { notificationForAttention } from "../dist/application/attention-notifications.js";

const channels = [
  { key: "reels", name: "Reels", platform: "instagram", accountId: "account:instagram:reels" }
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
  assert.match(first.subject, /🚨 Zwei Posts zielen auf denselben Kanal zur selben Zeit/);
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
  assert.match(message.body, /Video in Drive ablegen/);
});

test("the autonomous runtime hands the attention path its channel names and remote screen", async () => {
  const { readFileSync } = await import("node:fs");
  const runtime = readFileSync(new URL("../src/application/headless-autonomous-runtime.ts", import.meta.url).pathname, "utf8");
  assert.match(runtime, /channels: operatorChannels/);
  const workspace = readFileSync(new URL("../src/adapters/runtime/workspace-distribution-runtime.ts", import.meta.url).pathname, "utf8");
  assert.match(workspace, /FLERDVISION_REMOTE_SCREEN_URL/);
  assert.doesNotMatch(workspace, /uiBaseUrl/);
});
