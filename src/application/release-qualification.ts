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

export type QualificationGateDisplayStatus = "PASS" | "FAIL" | "NOT_RUN";
export interface QualificationChecklistItem {
  gate:QualificationGateKind;
  status:QualificationGateDisplayStatus;
  checkedAt?:string;
  summary?:string;
  artifactRefs:readonly string[];
}
export interface QualificationChecklist {
  run:ReleaseQualificationRun;
  complete:boolean;
  canFinalize:boolean;
  blockers:readonly string[];
  gates:readonly QualificationChecklistItem[];
}

function evidenceRefs(refs:readonly string[]|undefined):readonly string[]{
  return [...new Set((refs??[]).map(ref=>ref.trim()).filter(Boolean))];
}

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
    const refs=evidenceRefs(input.artifactRefs);
    if(input.passed&&refs.length===0)throw new Error(`Passing gate ${input.gate} requires at least one durable artifactRef`);
    return this.store.appendGate({ gateResultId: input.gateResultId ?? id("gate"), runId: input.runId, gate: input.gate, passed: input.passed,
      checkedAt: new Date(input.now).toISOString(), checkedBy: input.operatorId, summary: input.summary, artifactRefs: refs });
  }

  checklist(runId:string):QualificationChecklist{
    const run=this.store.getRun(runId);if(!run)throw new Error(`Unknown qualification run: ${runId}`);
    const required=requiredQualificationGates(run.stage),latest=new Map<QualificationGateKind,QualificationGateResult>();
    for(const result of this.store.listGates(runId))latest.set(result.gate,result);
    const gates:QualificationChecklistItem[]=required.map(gate=>{
      const result=latest.get(gate);
      if(!result)return{gate,status:"NOT_RUN",artifactRefs:[]};
      return{gate,status:result.passed?"PASS":"FAIL",checkedAt:result.checkedAt,summary:result.summary,artifactRefs:result.artifactRefs};
    });
    const blockers=gates.filter(item=>item.status!=="PASS").map(item=>`${item.gate}:${item.status}`);
    return{run,complete:gates.every(item=>item.status!=="NOT_RUN"),canFinalize:blockers.length===0,gates,blockers};
  }

  finalize(runId: string): ReleaseQualificationRun {
    const checklist=this.checklist(runId),run=checklist.run;
    const missing=checklist.gates.filter(item=>item.status==="NOT_RUN").map(item=>item.gate);
    if (missing.length) throw new Error(`Qualification run ${runId} missing gates: ${missing.join(", ")}`);
    return this.store.updateRunStatus(runId, checklist.canFinalize ? "PASSED" : "FAILED");
  }
}
