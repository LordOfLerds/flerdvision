import test from "node:test";
import assert from "node:assert/strict";
import { notificationForAttention } from "../dist/application/attention-notifications.js";

test("attention notifications are quiet for INFO and deterministic for actionable states", () => {
  const info = notificationForAttention({
    attentionId: "a-info", severity: "INFO", kind: "BACKLOG", title: "Backlog", impact: "Moved", deepLink: "/content/x"
  }, "2026-08-27T06:00:00.000Z");
  assert.equal(info, null);

  const item = {
    attentionId: "a-critical", severity: "CRITICAL", kind: "ACCOUNT_SLOT_CONFLICT", title: "Slot conflict",
    impact: "Two deliveries target the same account", accountId: "ig1", routeId: "r1", deepLink: "/routes/r1"
  };
  const policy = {
    notify: { INFO: false, WARNING: true, ACTION_REQUIRED: true, CRITICAL: true },
    uiBaseUrl: "https://ops.example.test/"
  };
  const first = notificationForAttention(item, "2026-08-27T06:00:00.000Z", policy);
  const second = notificationForAttention(item, "2026-08-27T06:00:00.000Z", policy);
  assert.deepEqual(first, second);
  assert.equal(first.severity, "CRITICAL");
  assert.equal(first.accountId, "ig1");
  assert.equal(first.metadata.deepLink, "https://ops.example.test/routes/r1");
});
