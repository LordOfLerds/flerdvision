import type { ReleaseQualificationStorePort } from "../domain/workspace-ports.js";
import {
  requiredQualificationGates,
  stagePredecessor,
  type DeploymentStage,
  type QualificationGateKind,
  type QualificationGateResult,
  type ReleaseQualificationRun
} from "../domain/workspace.js";

function id(prefix: string): string { return `${prefix}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2,10)}`; }

export class ReleaseQualificationService {
  constructor(private readonly store: ReleaseQualificationStorePort) {}

  start(input: { releaseSha: string; stage: DeploymentStage; workspaceId: string; hostFingerprint: string; now: string; operatorId: string; runId?: string }): ReleaseQualificationRun {
    const predecessor = stagePredecessor(input.stage);
    if (predecessor) {
      const predecessorPassed = this.store.listRuns(input.releaseSha).some((run) => run.stage === predecessor && run.status === "PASSED");
      if (!predecessorPassed) throw new Error(`Release ${input.releaseSha} has not passed predecessor stage ${predecessor}`);
    }
    return this.store.createRun({
      runId: input.runId ?? id("qualification"), releaseSha: input.releaseSha, stage: input.stage, workspaceId: input.workspaceId,
      hostFingerprint: input.hostFingerprint, createdAt: new Date(input.now).toISOString(), createdBy: input.operatorId, status: "ACTIVE"
    });
  }

  recordGate(input: { runId: string; gate: QualificationGateKind; passed: boolean; now: string; operatorId: string; summary: string; artifactRefs?: readonly string[]; gateResultId?: string }): QualificationGateResult {
    const run = this.store.getRun(input.runId); if (!run) throw new Error(`Unknown qualification run: ${input.runId}`);
    if (run.status !== "ACTIVE") throw new Error(`Qualification run ${input.runId} is ${run.status}`);
    if (!requiredQualificationGates(run.stage).includes(input.gate)) throw new Error(`Gate ${input.gate} is not required for ${run.stage}`);
    return this.store.appendGate({ gateResultId: input.gateResultId ?? id("gate"), runId: input.runId, gate: input.gate, passed: input.passed,
      checkedAt: new Date(input.now).toISOString(), checkedBy: input.operatorId, summary: input.summary, artifactRefs: input.artifactRefs ?? [] });
  }

  finalize(runId: string): ReleaseQualificationRun {
    const run = this.store.getRun(runId); if (!run) throw new Error(`Unknown qualification run: ${runId}`);
    const gates = this.store.listGates(runId);
    const required = requiredQualificationGates(run.stage);
    const latestByGate = new Map<QualificationGateKind, QualificationGateResult>();
    for (const gate of gates) latestByGate.set(gate.gate, gate);
    const missing = required.filter((gate) => !latestByGate.has(gate));
    if (missing.length) throw new Error(`Qualification run ${runId} missing gates: ${missing.join(", ")}`);
    const failed = required.filter((gate) => latestByGate.get(gate)?.passed !== true);
    return this.store.updateRunStatus(runId, failed.length ? "FAILED" : "PASSED");
  }
}
