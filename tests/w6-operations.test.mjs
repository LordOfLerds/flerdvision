import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteControlPlaneStore } from "../dist/adapters/storage/sqlite.js";
import { OpsHttpServer } from "../dist/adapters/ops/http-server.js";
import { RecordingNotificationAdapter } from "../dist/adapters/notify/webhook.js";
import { NotificationDispatcher } from "../dist/application/notifications.js";
import {
  DailyOperationsService,
  HumanRecoveryError,
  HumanRecoveryService,
  IncidentNotificationService,
  KillSwitchGate,
  KillSwitchService,
  OperationalKillSwitchError,
  OperationsIncidentProjector
} from "../dist/application/operations.js";
import { PublicationScheduler, DueWorkClaimer } from "../dist/application/scheduler.js";
import { DurableFinalActionService } from "../dist/application/durable-final-action.js";

const actor = { type: "test", id: "w6" };

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), "flerdvision-w6-"));
  return { dir, path: join(dir, "ops.sqlite") };
}

function registerBrowser(store, state = "HEALTHY", checkedAt = "2026-08-26T06:50:00Z") {
  store.registerSocialAccount({ accountId: "acct:test", creatorId: "creator:test", platform: "instagram", expectedHandle: "test_handle", enabled: true }, "2026-08-26T06:40:00Z", actor);
  store.registerBrowserIdentity({ identityId: "browser:test", accountId: "acct:test", platform: "instagram", profileKey: "instagram/test", expectedHandle: "test_handle", enabled: true }, "2026-08-26T06:41:00Z", actor);
  store.recordSessionHealth({ checkId: `health:${state}:${checkedAt}`, identityId: "browser:test", checkedAt, state, expectedHandle: "test_handle", ...(state === "HEALTHY" ? { observedHandle: "test_handle" } : {}) }, actor);
}

function createScheduledIntent(store, intentId = "intent:test", scheduledFor = "2026-08-26T07:00:00Z") {
  store.createOrGetIntent({
    intentId, contentId: `content:${intentId}`, creatorId: "creator:test", platform: "instagram", accountId: "acct:test",
    format: "reel", copyVersionId: "copy:v1", scheduledFor, idempotencyKey: `idem:${intentId}`
  }, "2026-08-26T06:45:00Z", actor);
  store.transitionIntent(intentId, "READY", "2026-08-26T06:46:00Z", actor);
  new PublicationScheduler(store).scheduleIntent(intentId, "2026-08-26T06:47:00Z", actor);
  return store.getReservationForIntent(intentId);
}

test("migration 6 creates operations tables and append-only human/notification records", () => {
  const runtime = tempDb();
  const store = new SqliteControlPlaneStore(runtime.path);
  try {
    const raw = new DatabaseSync(runtime.path);
    try {
      const versions = raw.prepare("SELECT version FROM schema_migrations ORDER BY version").all().map((row) => Number(row.version));
      assert.deepEqual(versions.slice(0, 6), [1, 2, 3, 4, 5, 6]);
      for (const table of ["incidents", "human_actions", "kill_switches", "notification_messages", "notification_deliveries"]) {
        assert.equal(raw.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name=?").get(table).c, 1);
      }
    } finally { raw.close(); }
  } finally { store.close(); rmSync(runtime.dir, { recursive: true, force: true }); }
});

test("incident projection deduplicates repeated session failures and reopens after recurrence", () => {
  const store = new SqliteControlPlaneStore(":memory:");
  try {
    registerBrowser(store, "AUTH_REQUIRED", "2026-08-26T06:50:00Z");
    const projector = new OperationsIncidentProjector(store);
    const first = projector.project("2026-08-26T06:51:00Z", actor);
    const second = projector.project("2026-08-26T06:52:00Z", actor);
    assert.equal(first.created, 1);
    assert.equal(second.created, 0);
    assert.equal(store.listIncidents().length, 1);
    const incident = store.listIncidents()[0];
    assert.equal(incident.kind, "AUTH_REQUIRED");
    assert.equal(incident.occurrenceCount, 1, "same source health observation must not inflate occurrence count");

    new HumanRecoveryService(store).resolveIncident(incident.incidentId, "2026-08-26T06:53:00Z", "operator-a", "logged back in");
    store.recordSessionHealth({ checkId: "health:auth:new", identityId: "browser:test", checkedAt: "2026-08-26T06:54:00Z", state: "AUTH_REQUIRED", expectedHandle: "test_handle" }, actor);
    const third = projector.project("2026-08-26T06:55:00Z", actor);
    assert.equal(third.created, 0, "same fingerprint is reopened instead of creating duplicate incident");
    const reopened = store.listIncidents()[0];
    assert.equal(reopened.status, "OPEN");
    assert.equal(reopened.occurrenceCount, 2);
  } finally { store.close(); }
});

test("incident notification is outbox-deduplicated and delivered once", async () => {
  const store = new SqliteControlPlaneStore(":memory:");
  try {
    registerBrowser(store, "AUTH_REQUIRED");
    const projected = new OperationsIncidentProjector(store).project("2026-08-26T06:51:00Z", actor);
    const incident = store.getIncident(projected.createdIncidentIds[0]);
    const notify = new IncidentNotificationService(store, ["bot"]);
    notify.enqueueNewIncident(incident, actor);
    notify.enqueueNewIncident(incident, actor);
    assert.equal(store.listNotificationDeliveries().length, 1);
    const adapter = new RecordingNotificationAdapter("bot");
    const one = await new NotificationDispatcher(store, [adapter]).dispatchPending("2026-08-26T06:52:00Z", actor);
    const two = await new NotificationDispatcher(store, [adapter]).dispatchPending("2026-08-26T06:53:00Z", actor);
    assert.deepEqual(one, { attempted: 1, sent: 1, failed: 0 });
    assert.deepEqual(two, { attempted: 0, sent: 0, failed: 0 });
    assert.equal(adapter.sent.length, 1);
  } finally { store.close(); }
});

test("failed notification delivery is retryable without duplicating message", async () => {
  const store = new SqliteControlPlaneStore(":memory:");
  let calls = 0;
  const adapter = {
    channelKey: "bot",
    async send() { calls += 1; if (calls === 1) throw new Error("temporary outage"); return { externalMessageId: "ok:1" }; }
  };
  try {
    store.enqueueNotification({ notificationId: "n:1", dedupeKey: "daily:x", kind: "SYSTEM", severity: "INFO", createdAt: "2026-08-26T06:00:00Z", subject: "x", body: "x", metadata: {} }, ["bot"], actor);
    const dispatcher = new NotificationDispatcher(store, [adapter]);
    assert.equal((await dispatcher.dispatchPending("2026-08-26T06:01:00Z", actor)).failed, 1);
    assert.equal(store.listNotificationDeliveries()[0].status, "FAILED");
    assert.equal((await dispatcher.dispatchPending("2026-08-26T06:02:00Z", actor)).sent, 1);
    const delivery = store.listNotificationDeliveries()[0];
    assert.equal(delivery.status, "SENT");
    assert.equal(delivery.attempts, 2);
  } finally { store.close(); }
});

test("global kill switch blocks work claiming and final boundary entry", async () => {
  const store = new SqliteControlPlaneStore(":memory:");
  try {
    registerBrowser(store);
    createScheduledIntent(store);
    const gate = new KillSwitchGate(store);
    const switchService = new KillSwitchService(store);
    switchService.set("GLOBAL", "*", true, "maintenance", "2026-08-26T06:55:00Z", "operator-a");
    assert.equal(new DueWorkClaimer(store, gate).claimNext("worker-a", "2026-08-26T07:00:00Z", 60), null);

    switchService.set("GLOBAL", "*", false, "maintenance complete", "2026-08-26T06:56:00Z", "operator-a");
    const claimed = new DueWorkClaimer(store, gate).claimNext("worker-a", "2026-08-26T07:00:00Z", 60);
    assert.equal(claimed.record.state, "PREPARING");
    store.recordPreparedAttempt({
      attemptId: "attempt:test", intentId: "intent:test", browserIdentityId: "browser:test", releaseSha: "w6",
      startedAt: "2026-08-26T07:00:01Z", finishedAt: "2026-08-26T07:00:02Z", result: "prepared",
      mediaSha256: "a".repeat(64), preparationArtifactRefs: [], reachedFinalActionBoundary: true
    }, actor);
    switchService.set("ACCOUNT", "acct:test", true, "emergency stop", "2026-08-26T07:00:03Z", "operator-a");
    let invokes = 0;
    const final = new DurableFinalActionService(store, { async invoke() { invokes += 1; return { invokedAt: "2026-08-26T07:00:04Z", evidence: [] }; } }, () => "2026-08-26T07:00:04Z", gate);
    await assert.rejects(
      () => final.execute("intent:test", "attempt:test", { mode: "test_account", allowFinalPublish: true, allowedAccountIds: new Set(["acct:test"]), releaseSha: "w6" }, actor),
      OperationalKillSwitchError
    );
    assert.equal(invokes, 0);
    assert.equal(store.getPublishAttempt("attempt:test").result, "prepared");
    assert.equal(store.getIntent("intent:test").state, "PREPARING");
  } finally { store.close(); }
});

test("human resume requires healthy browser and a still-valid original window", () => {
  const store = new SqliteControlPlaneStore(":memory:");
  try {
    registerBrowser(store, "AUTH_REQUIRED", "2026-08-26T06:50:00Z");
    const reservation = createScheduledIntent(store);
    store.transitionIntent("intent:test", "BLOCKED", "2026-08-26T06:55:00Z", actor, "auth_required");
    const recovery = new HumanRecoveryService(store);
    assert.throws(() => recovery.resumeIntent("intent:test", "2026-08-26T06:56:00Z", "operator-a", "auth fixed"), HumanRecoveryError);
    store.recordSessionHealth({ checkId: "health:healthy", identityId: "browser:test", checkedAt: "2026-08-26T06:57:00Z", state: "HEALTHY", expectedHandle: "test_handle", observedHandle: "test_handle" }, actor);
    recovery.resumeIntent("intent:test", "2026-08-26T06:58:00Z", "operator-a", "auth fixed");
    assert.equal(store.getIntent("intent:test").state, "SCHEDULED");
    store.transitionIntent("intent:test", "BLOCKED", "2026-08-26T07:01:00Z", actor, "simulated later block");
    const afterWindow = new Date(new Date(reservation.windowEndAt).getTime() + 1000).toISOString();
    assert.throws(() => recovery.resumeIntent("intent:test", afterWindow, "operator-a", "too late"), /window has expired/);
    recovery.waiveIntent("intent:test", afterWindow, "operator-a", "skip missed slot");
    assert.equal(store.getIntent("intent:test").state, "WAIVED");
    assert.ok(store.listHumanActions("intent:test").some((item) => item.kind === "INTENT_WAIVED"));
  } finally { store.close(); }
});

test("PUBLISH_UNCERTAIN can never be bypassed with human resume", () => {
  const store = new SqliteControlPlaneStore(":memory:");
  try {
    registerBrowser(store);
    createScheduledIntent(store);
    store.transitionIntent("intent:test", "PREPARING", "2026-08-26T06:59:00Z", actor);
    store.transitionIntent("intent:test", "PUBLISHING", "2026-08-26T07:00:00Z", actor);
    store.transitionIntent("intent:test", "PUBLISH_UNCERTAIN", "2026-08-26T07:00:01Z", actor);
    assert.throws(() => new HumanRecoveryService(store).resumeIntent("intent:test", "2026-08-26T07:00:02Z", "operator-a", "try"), /reconciliation/);
  } finally { store.close(); }
});

test("daily readiness and completion summaries reflect actual intent states", () => {
  const store = new SqliteControlPlaneStore(":memory:");
  try {
    registerBrowser(store);
    createScheduledIntent(store, "intent:a", "2026-08-26T07:00:00Z");
    store.createOrGetIntent({ intentId: "intent:b", contentId: "content:b", creatorId: "creator:test", platform: "instagram", accountId: "acct:test", format: "reel", copyVersionId: "copy", scheduledFor: "2026-08-26T09:00:00Z", idempotencyKey: "idem:b" }, "2026-08-26T06:00:00Z", actor);
    store.transitionIntent("intent:b", "READY", "2026-08-26T06:01:00Z", actor);
    store.transitionIntent("intent:b", "WAIVED", "2026-08-26T06:02:00Z", actor, "test waiver");
    const daily = new DailyOperationsService(store);
    const summary = daily.summary("2026-08-26", "2026-08-26T06:30:00Z");
    assert.equal(summary.total, 2);
    assert.equal(summary.waived, 1);
    assert.equal(summary.scheduledOrActive, 1);
    assert.match(daily.readinessMessage("2026-08-26", "2026-08-26T06:30:00Z").body, /2 planned publications/);
    assert.match(daily.completionMessage("2026-08-26", "2026-08-26T17:30:00Z").subject, /incomplete/);
  } finally { store.close(); }
});

test("minimal ops UI is localhost, authenticated and can acknowledge an incident with CSRF", { timeout: 15_000 }, async () => {
  const store = new SqliteControlPlaneStore(":memory:");
  const server = new OpsHttpServer(store, { password: "test-password", username: "ops", now: () => "2026-08-26T06:51:00Z", businessDate: () => "2026-08-26" });
  try {
    registerBrowser(store, "AUTH_REQUIRED");
    new OperationsIncidentProjector(store).project("2026-08-26T06:51:00Z", actor);
    const incident = store.listIncidents()[0];
    const bound = await server.start();
    assert.equal(bound.host, "127.0.0.1");
    const base = `http://127.0.0.1:${bound.port}`;
    const unauth = await fetch(base + "/");
    assert.equal(unauth.status, 401);
    const auth = `Basic ${Buffer.from("ops:test-password").toString("base64")}`;
    const page = await fetch(base + "/", { headers: { authorization: auth } });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Flerdvision Operations/);
    const csrf = html.match(/name="csrf" value="([a-f0-9]+)"/)?.[1];
    assert.ok(csrf);
    const bad = await fetch(`${base}/actions/incidents/${encodeURIComponent(incident.incidentId)}/ack`, { method: "POST", headers: { authorization: auth, "content-type": "application/x-www-form-urlencoded" }, body: "note=x", redirect: "manual" });
    assert.equal(bad.status, 403);
    const good = await fetch(`${base}/actions/incidents/${encodeURIComponent(incident.incidentId)}/ack`, { method: "POST", headers: { authorization: auth, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf, note: "working on login" }), redirect: "manual" });
    assert.equal(good.status, 303);
    assert.equal(store.getIncident(incident.incidentId).status, "ACKNOWLEDGED");
  } finally { await server.stop(); store.close(); }
});

test("human_actions and notification_messages are immutable at database level", () => {
  const runtime = tempDb();
  const store = new SqliteControlPlaneStore(runtime.path);
  try {
    registerBrowser(store, "AUTH_REQUIRED");
    const incident = store.getIncident(new OperationsIncidentProjector(store).project("2026-08-26T06:51:00Z", actor).createdIncidentIds[0]);
    new HumanRecoveryService(store).acknowledgeIncident(incident.incidentId, "2026-08-26T06:52:00Z", "operator-a", "seen");
    new IncidentNotificationService(store, ["bot"]).enqueueNewIncident(incident, actor);
  } finally { store.close(); }
  const raw = new DatabaseSync(runtime.path);
  try {
    assert.throws(() => raw.exec("UPDATE human_actions SET operator_id = 'tampered'"), /append-only/);
    assert.throws(() => raw.exec("DELETE FROM notification_messages"), /append-only/);
  } finally { raw.close(); rmSync(runtime.dir, { recursive: true, force: true }); }
});

test("blocked missed-window reason still projects an incident after MissedWindowGuard already changed state", async () => {
  const { MissedWindowGuard } = await import("../dist/application/scheduler.js");
  const store = new SqliteControlPlaneStore(":memory:");
  try {
    registerBrowser(store);
    createScheduledIntent(store, "intent:missed", "2026-08-26T07:00:00Z");
    const blocked = new MissedWindowGuard(store).blockMissed("2026-08-26T07:31:00Z", actor);
    assert.deepEqual(blocked, ["intent:missed"]);
    const result = new OperationsIncidentProjector(store).project("2026-08-26T07:31:01Z", actor);
    assert.equal(result.created, 1);
    assert.equal(store.listIncidents()[0].kind, "MISSED_WINDOW");
  } finally { store.close(); }
});

test("operations cycle emits readiness/completion once per dedupe key despite repeated polling", async () => {
  const { OperationsCycleService } = await import("../dist/application/operations.js");
  const store = new SqliteControlPlaneStore(":memory:");
  try {
    registerBrowser(store);
    createScheduledIntent(store);
    const cycle = new OperationsCycleService(store, { channelKeys: ["bot"] });
    const before = cycle.run("2026-08-26T06:00:00Z", actor); // 08:00 Vienna
    assert.equal(before.readinessEnqueued, false);
    cycle.run("2026-08-26T06:31:00Z", actor); // 08:31 Vienna
    cycle.run("2026-08-26T06:32:00Z", actor);
    assert.equal(store.listNotificationDeliveries().filter((item) => item.notificationId.includes("notification:")).length, 1);
    cycle.run("2026-08-26T15:31:00Z", actor); // 17:31 Vienna
    cycle.run("2026-08-26T15:32:00Z", actor);
    const deliveries = store.listNotificationDeliveries();
    const kinds = deliveries.map((item) => store.getNotification(item.notificationId).kind);
    assert.equal(kinds.filter((kind) => kind === "READINESS").length, 1);
    assert.equal(kinds.filter((kind) => kind === "COMPLETION").length, 1);
    assert.equal(kinds.filter((kind) => kind === "INCIDENT").length, 1, "missed window also produces one incident alert");
  } finally { store.close(); }
});

test("webhook notification adapter sends deterministic idempotency key and optional bearer token", async () => {
  const { WebhookNotificationAdapter } = await import("../dist/adapters/notify/webhook.js");
  let captured;
  const adapter = new WebhookNotificationAdapter({
    channelKey: "bot",
    url: "https://bot.invalid/notify",
    bearerToken: "secret-token",
    async fetchImpl(url, init) {
      captured = { url, init };
      return new Response("ok", { status: 200, headers: { "x-message-id": "msg:123" } });
    }
  });
  const receipt = await adapter.send({
    notificationId: "n:webhook", dedupeKey: "incident:abc:opened", kind: "INCIDENT", severity: "ERROR",
    createdAt: "2026-08-26T06:00:00Z", subject: "Problem", body: "Details", metadata: {}
  });
  assert.equal(captured.url, "https://bot.invalid/notify");
  assert.equal(captured.init.headers["idempotency-key"], "incident:abc:opened");
  assert.equal(captured.init.headers.authorization, "Bearer secret-token");
  assert.equal(JSON.parse(captured.init.body).subject, "Problem");
  assert.deepEqual(receipt, { externalMessageId: "msg:123" });
});

test("reopened incidents produce a new deduplicated notification occurrence", () => {
  const store = new SqliteControlPlaneStore(":memory:");
  try {
    registerBrowser(store, "AUTH_REQUIRED", "2026-08-26T06:50:00Z");
    const cycle = async (at) => {
      const { OperationsCycleService } = await import("../dist/application/operations.js");
      return new OperationsCycleService(store, { channelKeys: ["bot"], readinessMinuteLocal: 24 * 60, completionMinuteLocal: 24 * 60 }).run(at, actor);
    };
    return cycle("2026-08-26T06:51:00Z").then((first) => {
      assert.equal(first.enqueuedIncidentNotifications, 1);
      const incident = store.listIncidents()[0];
      new HumanRecoveryService(store).resolveIncident(incident.incidentId, "2026-08-26T06:52:00Z", "operator-a", "fixed");
      store.recordSessionHealth({ checkId: "health:auth:again", identityId: "browser:test", checkedAt: "2026-08-26T06:53:00Z", state: "AUTH_REQUIRED", expectedHandle: "test_handle" }, actor);
      return cycle("2026-08-26T06:54:00Z");
    }).then((second) => {
      assert.equal(second.enqueuedIncidentNotifications, 1);
      const incidentMessages = store.listNotificationDeliveries().map((d) => store.getNotification(d.notificationId)).filter((m) => m.kind === "INCIDENT");
      assert.equal(incidentMessages.length, 2);
      assert.notEqual(incidentMessages[0].dedupeKey, incidentMessages[1].dedupeKey);
    }).finally(() => store.close());
  } catch (error) { store.close(); throw error; }
});
