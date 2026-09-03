import test from "node:test";
import assert from "node:assert/strict";
import { SqliteControlPlaneStore } from "../dist/adapters/storage/sqlite.js";
import {
  IncidentReconciliationService,
  OperationsIncidentProjector
} from "../dist/application/operations.js";
import { PublicationScheduler } from "../dist/application/scheduler.js";

// Slice A: a blocker is a thing to be resolved, not a thing to be collected. The projector opens
// incidents from live state; nothing ever closed them, so /doctor grew a standing list of
// problems that had been over for days. Reconciliation closes an incident exactly when the
// condition that opened it is demonstrably gone -- and never touches an uncertain publication.

const actor = { type: "test", id: "a3" };

function registerAccount(store, state = "HEALTHY", checkedAt = "2026-09-02T06:50:00Z") {
  store.registerSocialAccount({ accountId: "acct:test", creatorId: "creator:test", platform: "instagram", expectedHandle: "test_handle", enabled: true }, "2026-09-02T06:40:00Z", actor);
  store.registerBrowserIdentity({ identityId: "browser:test", accountId: "acct:test", platform: "instagram", profileKey: "instagram/test", expectedHandle: "test_handle", enabled: true }, "2026-09-02T06:41:00Z", actor);
  store.recordSessionHealth({ checkId: `health:${state}:${checkedAt}`, identityId: "browser:test", checkedAt, state, expectedHandle: "test_handle", ...(state === "HEALTHY" ? { observedHandle: "test_handle" } : {}) }, actor);
}

function scheduledIntent(store, intentId = "intent:test") {
  store.createOrGetIntent({
    intentId, contentId: `content:${intentId}`, creatorId: "creator:test", platform: "instagram", accountId: "acct:test",
    format: "reel", copyVersionId: "copy:v1", scheduledFor: "2026-09-02T07:00:00Z", idempotencyKey: `idem:${intentId}`
  }, "2026-09-02T06:45:00Z", actor);
  store.transitionIntent(intentId, "READY", "2026-09-02T06:46:00Z", actor);
  new PublicationScheduler(store).scheduleIntent(intentId, "2026-09-02T06:47:00Z", actor);
  return intentId;
}

test("a re-login closes the session incident it opened", () => {
  const store = new SqliteControlPlaneStore(":memory:");
  try {
    registerAccount(store, "AUTH_REQUIRED");
    assert.equal(new OperationsIncidentProjector(store).project("2026-09-02T06:51:00Z", actor).created, 1);
    assert.equal(store.listIncidents(["OPEN"]).length, 1);

    // Still logged out: nothing is closed on a hopeful schedule.
    assert.equal(new IncidentReconciliationService(store).reconcile("2026-09-02T07:00:00Z", actor).resolved, 0);

    store.recordSessionHealth({ checkId: "health:back", identityId: "browser:test", checkedAt: "2026-09-02T08:00:00Z", state: "HEALTHY", expectedHandle: "test_handle", observedHandle: "test_handle" }, actor);
    const report = new IncidentReconciliationService(store).reconcile("2026-09-02T08:01:00Z", actor);
    assert.equal(report.resolved, 1);
    assert.equal(store.listIncidents(["OPEN"]).length, 0);
    assert.match(store.getIncident(report.resolvedIncidentIds[0]).resolutionNote, /wieder angemeldet/);
  } finally { store.close(); }
});

test("an intent that leaves BLOCKED closes its blocker", () => {
  const store = new SqliteControlPlaneStore(":memory:");
  try {
    registerAccount(store);
    const intentId = scheduledIntent(store);
    store.transitionIntent(intentId, "BLOCKED", "2026-09-02T07:05:00Z", actor, "auth required");
    assert.equal(new OperationsIncidentProjector(store).project("2026-09-02T07:06:00Z", actor).created, 1);

    assert.equal(new IncidentReconciliationService(store).reconcile("2026-09-02T07:07:00Z", actor).resolved, 0);
    store.transitionIntent(intentId, "SCHEDULED", "2026-09-02T07:10:00Z", actor, "human_resume:asset replaced");
    assert.equal(new IncidentReconciliationService(store).reconcile("2026-09-02T07:11:00Z", actor).resolved, 1);
    assert.equal(store.listIncidents(["OPEN"]).length, 0);
  } finally { store.close(); }
});

test("an uncertain publication stays frozen until verification, and is never retried by this service", () => {
  const store = new SqliteControlPlaneStore(":memory:");
  try {
    registerAccount(store);
    const intentId = scheduledIntent(store);
    store.transitionIntent(intentId, "PREPARING", "2026-09-02T07:00:30Z", actor);
    store.transitionIntent(intentId, "PUBLISHING", "2026-09-02T07:01:00Z", actor);
    store.transitionIntent(intentId, "PUBLISH_UNCERTAIN", "2026-09-02T07:02:00Z", actor, "outcome unknown");
    assert.equal(new OperationsIncidentProjector(store).project("2026-09-02T07:03:00Z", actor).created, 1);

    // The one rule this service must never break.
    assert.equal(new IncidentReconciliationService(store).reconcile("2026-09-02T09:00:00Z", actor).resolved, 0);
    assert.equal(store.getIntent(intentId).state, "PUBLISH_UNCERTAIN");
    assert.equal(store.listIncidents(["OPEN"]).length, 1);

    // Only the reconciliation path leads out of PUBLISH_UNCERTAIN, and only through VERIFYING.
    store.transitionIntent(intentId, "VERIFYING", "2026-09-02T09:29:00Z", actor, "reconciliation re-check");
    store.transitionIntent(intentId, "VERIFIED", "2026-09-02T09:30:00Z", actor, "reconciliation found the post");
    assert.equal(new IncidentReconciliationService(store).reconcile("2026-09-02T09:31:00Z", actor).resolved, 1);
  } finally { store.close(); }
});

test("a qualification run's own incident is closed on sight, whatever its state", () => {
  const store = new SqliteControlPlaneStore(":memory:");
  try {
    registerAccount(store);
    const created = store.createOrRefreshIncident({
      fingerprint: "PUBLISH_UNCERTAIN:qualification:9f2a11bc",
      kind: "PUBLISH_UNCERTAIN",
      severity: "CRITICAL",
      title: "Publication outcome uncertain",
      summary: "Intent qualification:9f2a11bc may already be published.",
      observedAt: "2026-09-02T07:00:00Z",
      scope: { intentId: "qualification:9f2a11bc", accountId: "acct:test" }
    }, actor);
    assert.equal(created.created, true);
    const report = new IncidentReconciliationService(store).reconcile("2026-09-02T07:01:00Z", actor);
    assert.deepEqual(report.resolvedIncidentIds, [created.incident.incidentId]);
    assert.match(store.getIncident(created.incident.incidentId).resolutionNote, /Qualifikationslauf/);
    assert.equal(store.listIncidents(["OPEN"]).length, 0);
  } finally { store.close(); }
});

test("reconciliation is idempotent and leaves a still-live cause alone", () => {
  const store = new SqliteControlPlaneStore(":memory:");
  try {
    registerAccount(store, "CHALLENGE");
    new OperationsIncidentProjector(store).project("2026-09-02T06:51:00Z", actor);
    const service = new IncidentReconciliationService(store);
    assert.equal(service.reconcile("2026-09-02T07:00:00Z", actor).resolved, 0);
    assert.equal(service.reconcile("2026-09-02T07:05:00Z", actor).resolved, 0);
    assert.equal(store.listIncidents(["OPEN"]).length, 1);

    store.recordSessionHealth({ checkId: "health:solved", identityId: "browser:test", checkedAt: "2026-09-02T08:00:00Z", state: "HEALTHY", expectedHandle: "test_handle", observedHandle: "test_handle" }, actor);
    assert.equal(service.reconcile("2026-09-02T08:01:00Z", actor).resolved, 1);
    assert.equal(service.reconcile("2026-09-02T08:02:00Z", actor).resolved, 0);
  } finally { store.close(); }
});
