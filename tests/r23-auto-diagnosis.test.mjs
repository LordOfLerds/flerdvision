import test from "node:test";
import assert from "node:assert/strict";
import { AutoDiagnosisCoordinator, isAutoDiagnosableIncident } from "../dist/application/auto-diagnosis.js";

function incident(id, kind, lastObservedAt = "2026-09-05T12:00:00.000Z") {
  return {
    incidentId: id,
    fingerprint: `fp:${id}`,
    kind,
    severity: "ERROR",
    title: kind,
    summary: `${kind} summary`,
    scope: {},
    evidenceRefs: [],
    metadata: {},
    status: "OPEN",
    openedAt: "2026-09-05T11:59:00.000Z",
    lastObservedAt,
    occurrenceCount: 1
  };
}

function verdict() {
  return {
    decision: "AUTO_CANDIDATE",
    reason: "test",
    allowedPathPrefixes: [],
    deniedPathPrefixes: [],
    requireRegressionTest: true,
    allowPrepareOnlyReplay: true
  };
}

function harness(items, options = {}) {
  const incidents = { listIncidents: () => items };
  const diagnoses = new Map();
  const repairStore = { listAiDiagnoses: (incidentId) => diagnoses.get(incidentId) ?? [] };
  const calls = [];
  const lifecycleEvents = [];
  const runner = {
    async diagnoseIncident(incidentId, params) {
      calls.push({ incidentId, params });
      if (options.fail) throw new Error("diagnosis unavailable");
      diagnoses.set(incidentId, [{ incidentId, createdAt: params.now }]);
      return { verdict: verdict() };
    }
  };
  const coordinator = new AutoDiagnosisCoordinator(incidents, repairStore, runner, {
    releaseSha: "release:test",
    adapterVersion: "surface:test",
    maxPerCycle: options.maxPerCycle ?? 20,
    lifecycle: {
      onLifecycle(event) {
        lifecycleEvents.push(event);
        if (options.lifecycleFail) throw new Error("operator channel unavailable");
      }
    }
  });
  return { coordinator, calls, diagnoses, lifecycleEvents };
}

test("reconciliation and human-owned incidents are excluded before any AI call", async () => {
  const blocked = ["PUBLISH_UNCERTAIN", "AUTH_REQUIRED", "CHALLENGE", "IDENTITY_MISMATCH", "MISSED_WINDOW", "POLICY_WARNING", "COPYRIGHT_WARNING", "ACCOUNT_WARNING"];
  for (const kind of blocked) assert.equal(isAutoDiagnosableIncident(incident(`i:${kind}`, kind)), false, kind);
  assert.equal(isAutoDiagnosableIncident(incident("i:ui", "UI_UNKNOWN")), true);

  const items = [...blocked.map((kind) => incident(`i:${kind}`, kind)), incident("i:ui", "UI_UNKNOWN")];
  const { coordinator, calls, lifecycleEvents } = harness(items);
  const report = await coordinator.run("2026-09-05T12:05:00.000Z");

  assert.deepEqual(calls.map((call) => call.incidentId), ["i:ui"]);
  assert.deepEqual(lifecycleEvents.map((event) => [event.stage, event.incidentId]), [["STARTED", "i:ui"], ["DIAGNOSED", "i:ui"]]);
  assert.equal(report.skippedPolicy, blocked.length);
  assert.equal(report.diagnosed, 1);
});

test("a diagnosis is durable dedupe for one occurrence but a later occurrence is diagnosed again", async () => {
  const current = incident("i:repeat", "SYSTEM_ERROR", "2026-09-05T12:00:00.000Z");
  const { coordinator, calls, diagnoses, lifecycleEvents } = harness([current]);
  diagnoses.set(current.incidentId, [{ incidentId: current.incidentId, createdAt: "2026-09-05T12:01:00.000Z" }]);

  const first = await coordinator.run("2026-09-05T12:02:00.000Z");
  assert.equal(first.skippedFresh, 1);
  assert.equal(calls.length, 0);
  assert.equal(lifecycleEvents.length, 0);

  current.lastObservedAt = "2026-09-05T12:03:00.000Z";
  current.occurrenceCount = 2;
  const second = await coordinator.run("2026-09-05T12:04:00.000Z");
  assert.equal(second.diagnosed, 1);
  assert.deepEqual(calls.map((call) => call.incidentId), [current.incidentId]);
  assert.deepEqual(lifecycleEvents.map((event) => [event.stage, event.occurrenceCount]), [["STARTED", 2], ["DIAGNOSED", 2]]);
});

test("the per-cycle budget bounds attempts even when the diagnosis provider fails", async () => {
  const items = [incident("i:3", "SYSTEM_ERROR", "2026-09-05T12:03:00.000Z"), incident("i:2", "SYSTEM_ERROR", "2026-09-05T12:02:00.000Z"), incident("i:1", "SYSTEM_ERROR", "2026-09-05T12:01:00.000Z")];
  const { coordinator, calls, lifecycleEvents } = harness(items, { maxPerCycle: 2, fail: true });
  const report = await coordinator.run("2026-09-05T12:05:00.000Z");

  assert.equal(report.attempted, 2);
  assert.equal(report.failed, 2);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.incidentId), ["i:3", "i:2"]);
  assert.deepEqual(lifecycleEvents.map((event) => [event.stage, event.incidentId]), [
    ["STARTED", "i:3"], ["FAILED", "i:3"], ["STARTED", "i:2"], ["FAILED", "i:2"]
  ]);
});

test("a lifecycle observer failure never changes diagnosis outcome", async () => {
  const { coordinator, calls, lifecycleEvents } = harness([incident("i:ui", "UI_UNKNOWN")], { lifecycleFail: true });
  const report = await coordinator.run("2026-09-05T12:05:00.000Z");
  assert.equal(report.diagnosed, 1);
  assert.equal(report.failed, 0);
  assert.equal(calls.length, 1);
  assert.deepEqual(lifecycleEvents.map((event) => event.stage), ["STARTED", "DIAGNOSED"]);
});
