import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  AutoDiagnosingRuntimeOperationsAdapter,
  PersistingIncidentDiagnosisRunner,
  createWorkspaceAutoDiagnosis
} from "../dist/adapters/runtime/workspace-auto-diagnosis.js";

test("diagnosis-only runner persists sanitized AI diagnosis and returns repair policy without a workspace", async () => {
  const incident = {
    incidentId: "incident:ui",
    fingerprint: "fp:ui",
    kind: "UI_UNKNOWN",
    severity: "ERROR",
    title: "UI changed",
    summary: "button changed",
    scope: {},
    evidenceRefs: [],
    metadata: {},
    status: "OPEN",
    openedAt: "2026-09-05T12:00:00.000Z",
    lastObservedAt: "2026-09-05T12:00:00.000Z",
    occurrenceCount: 1
  };
  const diagnoses = [];
  const incidents = { getIncident: (id) => id === incident.incidentId ? incident : undefined };
  const repairStore = {
    recordEvidenceBundle: (bundle) => bundle,
    recordAiDiagnosis: (diagnosis) => { diagnoses.push(diagnosis); return diagnosis; }
  };
  const builder = {
    build: (_incident, params) => ({
      bundleId: "bundle:ui",
      incidentId: incident.incidentId,
      capturedAt: params.capturedAt,
      releaseSha: params.releaseSha,
      adapterVersion: params.adapterVersion,
      redactionPolicyVersion: "test",
      incidentKind: incident.kind,
      incidentSummary: incident.summary,
      sanitizedContext: {},
      artifacts: [],
      redactionFindings: []
    })
  };
  const diagnosisPort = {
    async diagnose() {
      return {
        classification: "SELECTOR_DRIFT",
        confidence: 0.9,
        rootCause: "visible label changed",
        evidenceRationale: ["sanitized fixture"],
        proposedRepairKind: "SELECTOR_CONFIG_CHANGE",
        requiresHuman: false,
        securityNotes: []
      };
    }
  };

  const runner = new PersistingIncidentDiagnosisRunner(incidents, repairStore, builder, diagnosisPort);
  const result = await runner.diagnoseIncident(incident.incidentId, {
    now: "2026-09-05T12:05:00.000Z",
    releaseSha: "release:test",
    adapterVersion: "adapter:test"
  });

  assert.equal(result.verdict.decision, "AUTO_CANDIDATE");
  assert.equal(diagnoses.length, 1);
  assert.equal(diagnoses[0].incidentId, incident.incidentId);
  assert.equal(diagnoses[0].classification, "SELECTOR_DRIFT");
});

test("workspace provider is explicit and optional: missing/disabled stays off, enabled wrapper composes", () => {
  const root = mkdtempSync(join(tmpdir(), "flerdvision-auto-diagnosis-"));
  const configDir = join(root, "config");
  const evidenceDir = join(root, "evidence");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(evidenceDir, { recursive: true });
  const common = { store: {}, configDir, evidenceDir, releaseSha: "release:test", adapterVersion: "adapter:test", env: {} };
  try {
    assert.equal(createWorkspaceAutoDiagnosis(common), undefined);
    writeFileSync(join(configDir, "ai-provider.json"), JSON.stringify({ mode: "disabled", enabled: false }));
    assert.equal(createWorkspaceAutoDiagnosis(common), undefined);

    writeFileSync(join(configDir, "ai-provider.json"), JSON.stringify({
      mode: "claude_subscription_cli",
      enabled: true,
      wrapperCommand: process.execPath,
      wrapperArgs: [],
      timeoutMs: 60_000
    }));
    assert.ok(createWorkspaceAutoDiagnosis(common), "an explicitly configured executable wrapper should compose automatic diagnosis");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("operations facts survive diagnosis failure and diagnosis runs after projection", async () => {
  const order = [];
  const inner = {
    async projectAndNotify() {
      order.push("operations");
      return { incidentsCreated: 2, notificationsEnqueued: 1 };
    }
  };
  const diagnosis = {
    async run() {
      order.push("diagnosis");
      throw new Error("provider unavailable");
    }
  };
  const adapter = new AutoDiagnosingRuntimeOperationsAdapter(inner, diagnosis);
  const report = await adapter.projectAndNotify("2026-09-05T12:05:00.000Z");
  assert.deepEqual(order, ["operations", "diagnosis"]);
  assert.deepEqual(report, { incidentsCreated: 2, notificationsEnqueued: 1 });
});

test("workspace runtime source wires automatic diagnosis only as an operations decorator", () => {
  const source = readFileSync(new URL("../src/adapters/runtime/workspace-distribution-runtime.ts", import.meta.url).pathname, "utf8");
  assert.match(source, /createWorkspaceAutoDiagnosis/);
  assert.match(source, /new AutoDiagnosingRuntimeOperationsAdapter/);
  assert.doesNotMatch(source, /AiRepairService/);
});
