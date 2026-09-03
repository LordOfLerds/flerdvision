import { resolve } from "node:path";
import type { QualificationOperatorPort, QualificationOperatorStatus } from "../../domain/qualification-operator-ports.js";
import type { WorkspaceQualificationSyncReport } from "../../application/workspace-qualification-sync.js";
import { ReleaseQualificationService } from "../../application/release-qualification.js";
import { currentSurfaceFingerprintOrUndefined, describeSurfaceFingerprint } from "../../application/surface-fingerprint.js";
import { JsonWorkspaceRegistry } from "../workspace/json-registry.js";
import { WorkspaceQualificationSyncAdapter } from "./workspace-qualification-sync.js";

/** Binds Product Control Center to exactly one ACTIVE qualification run for this workspace/release. */
export class WorkspaceQualificationOperator implements QualificationOperatorPort {
  private readonly registry:JsonWorkspaceRegistry;
  private readonly release:ReleaseQualificationService;
  private readonly syncAdapter:WorkspaceQualificationSyncAdapter|undefined;
  private readonly runId:string|undefined;

  constructor(private readonly options:{runtimeRoot:string;workspaceId:string;releaseSha:string}){
    this.registry=new JsonWorkspaceRegistry(resolve(options.runtimeRoot,"registry","workspaces.json"));
    this.release=new ReleaseQualificationService(this.registry);
    const active=this.registry.listRuns(options.releaseSha).filter(run=>run.workspaceId===options.workspaceId&&run.status==="ACTIVE");
    if(active.length>1)throw new Error(`Multiple ACTIVE qualification runs exist for ${options.workspaceId} / ${options.releaseSha}; resolve them before using Product Control Center`);
    this.runId=active[0]?.runId;
    if(this.runId)this.syncAdapter=new WorkspaceQualificationSyncAdapter({runtimeRoot:options.runtimeRoot,workspaceId:options.workspaceId},this.registry);
  }

  status():QualificationOperatorStatus{
    if(!this.runId)return{available:false,reason:`No ACTIVE qualification run for workspace ${this.options.workspaceId} on release ${this.options.releaseSha}. Start one with the host installer/qualification CLI.`};
    // The host run stays release-bound (release-strict host order); the route evidence inside it
    // follows the surface fingerprint, so the operator sees both values in one status line.
    const fingerprint=currentSurfaceFingerprintOrUndefined();
    return{available:true,reason:`Active host qualification run is bound to this exact workspace/release. Oberflächen-Fingerabdruck ${fingerprint?describeSurfaceFingerprint(fingerprint):"unbekannt"}.`,runId:this.runId,checklist:this.release.checklist(this.runId)};
  }

  async sync(now:string,operatorId:string):Promise<WorkspaceQualificationSyncReport>{
    if(!this.runId||!this.syncAdapter)throw new Error(this.status().reason);
    return await this.syncAdapter.sync(this.runId,now,operatorId);
  }

  close():void{this.syncAdapter?.close();}
}
