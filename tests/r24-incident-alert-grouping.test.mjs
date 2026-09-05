import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  GroupedIncidentNotificationService,
  groupIncidentAlerts
} from "../dist/application/grouped-incident-notifications.js";

function incident(id, kind, options = {}) {
  return {
    incidentId: id,
    fingerprint: `fp:${id}`,
    kind,
    severity: kind === "PUBLISH_UNCERTAIN" ? "CRITICAL" : "ERROR",
    title: kind,
    summary: options.summary ?? `${kind} summary`,
    scope: {
      ...(options.intentId ? { intentId: options.intentId } : {}),
      ...(options.accountId ? { accountId: options.accountId } : {}),
      ...(options.platform ? { platform: options.platform } : {})
    },
    evidenceRefs: options.evidenceRefs ?? [],
    metadata: options.reason ? { reason: options.reason } : {},
    status: "OPEN",
    openedAt: options.openedAt ?? "2026-09-05T12:00:00.000Z",
    lastObservedAt: options.lastObservedAt ?? "2026-09-05T12:00:00.000Z",
    occurrenceCount: 1
  };
}

test("same sanitized technical root cause becomes one operator group while audit incidents remain separate", () => {
  const items = [
    incident("incident:b", "SYSTEM_ERROR", {
      intentId: "intent:b", accountId: "acct:youtube", platform: "youtube",
      lastObservedAt: "2026-09-05T12:02:00.000Z",
      reason: "runtime_due_blocked: Intent intent:b could not find Upload at /workspaces/ws/evidence/b.html",
      evidenceRefs: ["/private/failure-b.png"]
    }),
    incident("incident:a", "SYSTEM_ERROR", {
      intentId: "intent:a", accountId: "acct:youtube", platform: "youtube",
      lastObservedAt: "2026-09-05T12:01:00.000Z",
      reason: "runtime_due_blocked: Intent intent:a could not find Upload at /workspaces/ws/evidence/a.html"
    })
  ];

  const groups = groupIncidentAlerts(items);
  assert.equal(items.length, 2, "durable incidents remain separate facts");
  assert.equal(groups.length, 1);
  assert.equal(groups[0].incidents.length, 2);
  assert.equal(groups[0].primary.incidentId, "incident:b", "newest incident is the visible/diagnosed primary");
});

test("uncertain publication and other safety-owned incidents are never collapsed", () => {
  const groups = groupIncidentAlerts([
    incident("incident:u1", "PUBLISH_UNCERTAIN", { intentId: "intent:u1", accountId: "acct:youtube", platform: "youtube" }),
    incident("incident:u2", "PUBLISH_UNCERTAIN", { intentId: "intent:u2", accountId: "acct:youtube", platform: "youtube" }),
    incident("incident:a1", "AUTH_REQUIRED", { intentId: "intent:a1", accountId: "acct:youtube", platform: "youtube" }),
    incident("incident:a2", "AUTH_REQUIRED", { intentId: "intent:a2", accountId: "acct:youtube", platform: "youtube" })
  ]);
  assert.equal(groups.length, 4);
  assert.ok(groups.every((group) => group.incidents.length === 1));
});

test("one grouped Telegram incident says how many posts are affected and keeps the primary lifecycle key", () => {
  const first = incident("incident:primary", "UI_UNKNOWN", {
    intentId: "intent:primary", accountId: "acct:instagram", platform: "instagram",
    lastObservedAt: "2026-09-05T12:02:00.000Z"
  });
  const second = incident("incident:secondary", "UI_UNKNOWN", {
    intentId: "intent:secondary", accountId: "acct:instagram", platform: "instagram",
    lastObservedAt: "2026-09-05T12:01:00.000Z",
    evidenceRefs: ["/private/secondary-failure.png"]
  });
  // Same summary is the root-cause signature when no raw reason exists.
  first.summary = "composer button changed";
  second.summary = "composer button changed";
  const [group] = groupIncidentAlerts([second, first]);
  const enqueued = [];
  const outbox = {
    enqueueNotification(message, channels) {
      enqueued.push({ message, channels });
      return channels.map((channelKey) => ({ notificationId: message.notificationId, channelKey, status: "PENDING", attempts: 0 }));
    }
  };
  const service = new GroupedIncidentNotificationService(outbox, ["telegram"], [
    { key: "instagram", name: "Instagram", platform: "instagram", accountId: "acct:instagram" }
  ]);
  service.enqueueGroup(group, { type: "system", id: "test" });

  assert.equal(enqueued.length, 1);
  const message = enqueued[0].message;
  assert.equal(message.incidentId, "incident:primary");
  assert.equal(message.dedupeKey, "incident:incident:primary:occurrence:1");
  assert.equal(message.metadata.affectedCount, "2");
  assert.equal(message.metadata.screenshotPath, "/private/secondary-failure.png");
  assert.match(message.body, /Betroffen: 2 Posts mit derselben technischen Ursache/);
  assert.doesNotMatch(message.body, /incident:|\/private\//);
});

test("product runtime uses grouped incident notifications rather than legacy per-incident cycle", () => {
  const source = readFileSync(new URL("../src/adapters/runtime/safe-phase-adapters.ts", import.meta.url).pathname, "utf8");
  assert.match(source, /GroupedOperationsCycleService/);
  assert.doesNotMatch(source, /new OperationsCycleService\(/);
});
