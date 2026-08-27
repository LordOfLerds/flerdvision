import type { ControlCenterRuntimePort } from "../domain/control-center-ports.js";
import type { DistributionConfigurationStorePort } from "../domain/distribution-ports.js";
import type { ReleaseQualificationStorePort } from "../domain/workspace-ports.js";
import { requiredQualificationGates, type QualificationGateKind } from "../domain/workspace.js";
import { businessDateForInstant } from "../domain/scheduling.js";
import { ReleaseQualificationService } from "./release-qualification.js";
import { deriveWorkspaceQualificationEvidence } from "./workspace-qualification-evidence.js";

export interface WorkspaceQualificationSyncReport {
  runId:string;
  releaseSha:string;
  workspaceId:string;
  derivedGates:readonly QualificationGateKind[];
  recordedGates:readonly QualificationGateKind[];
  alreadyPassedGates:readonly QualificationGateKind[];
  stillBlocked:readonly string[];
  canFinalize:boolean;
}

export class WorkspaceQualificationSyncService {
  private readonly qualification:ReleaseQualificationService;
  constructor(
    private readonly store:ReleaseQualificationStorePort,
    private readonly config:DistributionConfigurationStorePort,
    private readonly runtime:ControlCenterRuntimePort,
    private readonly freshIdentityAccountIds:(checkedAfter:string)=>readonly string[],
    /**
     * The workspace this service is allowed to synchronize. Evidence is workspace-local, so
     * feeding it into a run that belongs to a different workspace would qualify a release on
     * observations that were never made on that host.
     */
    private readonly workspaceId:string
  ){
    this.qualification=new ReleaseQualificationService(store);
  }

  async sync(runId:string,now:string,operatorId:string):Promise<WorkspaceQualificationSyncReport>{
    const run=this.store.getRun(runId);if(!run)throw new Error(`Unknown qualification run: ${runId}`);
    if(run.workspaceId!==this.workspaceId)throw new Error(`Qualification run ${runId} belongs to workspace ${run.workspaceId}, not ${this.workspaceId}`);
    if(run.status!=="ACTIVE")throw new Error(`Qualification run ${runId} is ${run.status}; only ACTIVE runs may synchronize workspace evidence`);
    const stored=this.config.load();
    const timezone=stored.runtimePolicy?.readiness.timeZone??"Europe/Vienna";
    const timestamp=new Date(now).toISOString(),businessDate=businessDateForInstant(timestamp,timezone);
    const runtime=await this.runtime.snapshot(businessDate);
    const derived=deriveWorkspaceQualificationEvidence({
      workspaceId:run.workspaceId,
      releaseSha:run.releaseSha,
      qualificationStartedAt:run.createdAt,
      evaluatedAt:timestamp,
      freshIdentityAccountIds:this.freshIdentityAccountIds(run.createdAt),
      stored,
      runtime
    });
    const required=new Set(requiredQualificationGates(run.stage));
    const latest=new Map<QualificationGateKind,ReturnType<ReleaseQualificationStorePort["listGates"]>[number]>();
    for(const result of [...this.store.listGates(runId)].sort((a,b)=>a.checkedAt.localeCompare(b.checkedAt)||a.gateResultId.localeCompare(b.gateResultId)))latest.set(result.gate,result);
    const recorded:QualificationGateKind[]=[],alreadyPassed:QualificationGateKind[]=[];
    for(const evidence of derived){
      if(!required.has(evidence.gate))continue;
      if(latest.get(evidence.gate)?.passed){alreadyPassed.push(evidence.gate);continue;}
      this.qualification.recordGate({
        runId,
        gate:evidence.gate,
        passed:true,
        now:timestamp,
        operatorId,
        summary:evidence.summary,
        artifactRefs:evidence.artifactRefs
      });
      recorded.push(evidence.gate);
    }
    const checklist=this.qualification.checklist(runId);
    return{
      runId,
      releaseSha:run.releaseSha,
      workspaceId:run.workspaceId,
      derivedGates:derived.filter(item=>required.has(item.gate)).map(item=>item.gate).sort(),
      recordedGates:recorded.sort(),
      alreadyPassedGates:alreadyPassed.sort(),
      stillBlocked:checklist.blockers,
      canFinalize:checklist.canFinalize
    };
  }
}
