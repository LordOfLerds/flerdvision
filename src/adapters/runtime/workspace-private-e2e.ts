import { resolve } from "node:path";
import { AccountIdentityGuard } from "../../application/browser-identity-service.js";
import { PrivateE2EFinalActionController } from "../../application/private-e2e-live-publisher.js";
import { E2EPublishPermitService, PrivateE2ERunService } from "../../application/private-e2e.js";
import { RouteE2EGateBridge } from "../../application/route-test-execution.js";
import { workspaceRuntimeLayout } from "../../application/workspaces.js";
import type { Actor } from "../../domain/control-plane.js";
import type { E2EGateKind, E2EGateResult, E2EGateStatus, PrivateE2ERun } from "../../domain/e2e.js";
import type { PublishContext } from "../../domain/ports.js";
import type { PrivateE2ECommandPort, PrivateE2EIntentCandidate, PrivateE2ERunView } from "../../domain/private-e2e-command-ports.js";
import { KillSwitchGate } from "../../application/operations.js";
import { NodeHostPreflightAdapter } from "../e2e/host-preflight.js";
import { resolveChromiumExecutablePath } from "../browser/resolve-chromium.js";
import { resolveFfprobeExecutablePath } from "../media/resolve-ffprobe.js";
import { SqliteDistributionProvenanceStore } from "../distribution/sqlite-provenance.js";
import { SqlitePlatformSurfaceStore } from "../distribution/sqlite-surface-store.js";
import { SqliteRouteTestEvidenceStore } from "../distribution/sqlite-route-test-evidence.js";
import { SqliteControlPlaneStore } from "../storage/sqlite.js";
import { WorkspaceSurfacePublisher } from "./workspace-surface-publisher.js";

function runIdFor(intentId:string,releaseSha:string):string{return`private-e2e|${encodeURIComponent(intentId)}|${releaseSha}`;}
function intentIdFromRun(runId:string,releaseSha:string):string{const parts=runId.split("|");if(parts.length!==3||parts[0]!=="private-e2e"||parts[2]!==releaseSha)throw new Error(`Private E2E run ${runId} does not belong to release ${releaseSha}`);return decodeURIComponent(parts[1]!);}

export interface WorkspacePrivateE2EOptions {runtimeRoot:string;workspaceId:string;releaseSha:string;allowedAccountIds:ReadonlySet<string>;operatorId?:string;env?:Record<string,string|undefined>;chromiumExecutablePath?:string;}

/** Long-lived command workflow. Technical gates are derived from durable host/session/surface evidence; only privacy + cleanup are human attestations. */
export class WorkspacePrivateE2ECommands implements PrivateE2ECommandPort {
  private readonly layout:ReturnType<typeof workspaceRuntimeLayout>;
  private readonly store:SqliteControlPlaneStore;
  private readonly provenance:SqliteDistributionProvenanceStore;
  private readonly surfaces:SqlitePlatformSurfaceStore;
  private readonly routeEvidence:SqliteRouteTestEvidenceStore;
  private readonly bridge:RouteE2EGateBridge;
  private readonly runService:PrivateE2ERunService;
  private readonly permitService:E2EPublishPermitService;
  private readonly publisher:WorkspaceSurfacePublisher;
  private readonly finalController:PrivateE2EFinalActionController;
  private readonly preflight:NodeHostPreflightAdapter;
  private readonly operatorId:string;
  constructor(private readonly options:WorkspacePrivateE2EOptions){
    if(!options.releaseSha.trim())throw new Error("Private E2E requires exact releaseSha");this.operatorId=options.operatorId??"private-e2e";this.layout=workspaceRuntimeLayout(resolve(options.runtimeRoot),options.workspaceId);
    const env=options.env??process.env,chromiumExecutablePath=options.chromiumExecutablePath??env.CHROMIUM_EXECUTABLE_PATH??resolveChromiumExecutablePath();
    this.store=new SqliteControlPlaneStore(this.layout.databasePath);this.provenance=new SqliteDistributionProvenanceStore(this.layout.databasePath);this.surfaces=new SqlitePlatformSurfaceStore(this.layout.databasePath);this.routeEvidence=new SqliteRouteTestEvidenceStore(this.layout.databasePath);this.bridge=new RouteE2EGateBridge(this.routeEvidence);this.runService=new PrivateE2ERunService(this.store);this.permitService=new E2EPublishPermitService(this.store);
    this.publisher=new WorkspaceSurfacePublisher({runtimeRoot:options.runtimeRoot,workspaceId:options.workspaceId,releaseSha:options.releaseSha,env,chromiumExecutablePath,ownerId:`${options.workspaceId}:private-e2e`,headless:true});
    this.finalController=new PrivateE2EFinalActionController(this.store,this.store,this.publisher.finalAction,this.permitService,()=>new Date().toISOString(),new KillSwitchGate(this.store));
    this.preflight=new NodeHostPreflightAdapter({chromiumExecutablePath,ffprobeExecutablePath:env.FFPROBE_EXECUTABLE_PATH??resolveFfprobeExecutablePath(),runtimeDir:this.layout.workspaceRoot,profilesDir:this.layout.profilesDir,evidenceDir:this.layout.evidenceDir,expectedTimezone:env.TZ??"Europe/Vienna"});
  }
  private actor():Actor{return{type:"operator",id:this.operatorId};}
  private assertAllowed(accountId:string):void{if(!this.options.allowedAccountIds.has(accountId))throw new Error(`Account ${accountId} is not in FLERDVISION_PRIVATE_E2E_ACCOUNT_IDS`);}
  private intentForRun(runId:string){const intentId=intentIdFromRun(runId,this.options.releaseSha),record=this.store.getIntent(intentId);if(!record)throw new Error(`Private E2E intent not found: ${intentId}`);this.assertAllowed(record.intent.accountId);const run=this.store.getE2ERun(runId);if(!run)throw new Error(`Private E2E run not found: ${runId}`);if(run.accountId!==record.intent.accountId||run.platform!==record.intent.platform)throw new Error("Private E2E run/intent scope mismatch");return{run,record};}
  private route(intentId:string){const envelope=this.provenance.getIntent(intentId)?.envelope;if(!envelope)throw new Error(`Intent ${intentId} has no distribution provenance`);return envelope.provenance;}
  private surface(intentId:string){const provenance=this.route(intentId),intent=this.store.getIntent(intentId)?.intent;if(!intent)throw new Error(`Unknown intent ${intentId}`);return this.surfaces.latestContract(intent.accountId,provenance.postingProfileId);}
  private recordGate(run:PrivateE2ERun,gate:E2EGateKind,status:E2EGateStatus,checkedAt:string,summary:string,artifactRefs:readonly string[]=[],details:Readonly<Record<string,unknown>>={}):E2EGateResult{
    const result=this.runService.recordGate({runId:run.runId,gate,status,checkedAt:new Date(checkedAt).toISOString(),checkedBy:this.operatorId,summary,artifactRefs:[...artifactRefs],details},this.actor());
    const intentId=intentIdFromRun(run.runId,this.options.releaseSha),route=this.route(intentId),surface=this.surface(intentId);this.bridge.recordGate(route.routeId,result,this.options.releaseSha,surface?.contract.contractId);return result;
  }
  candidates():readonly PrivateE2EIntentCandidate[]{return this.store.listIntents(["SCHEDULED"]).filter(record=>this.options.allowedAccountIds.has(record.intent.accountId)).flatMap(record=>{const envelope=this.provenance.getIntent(record.intent.intentId)?.envelope;if(!envelope)return[];const surface=this.surfaces.latestContract(record.intent.accountId,envelope.provenance.postingProfileId);return[{intent:record.intent,routeId:envelope.provenance.routeId,...(surface?{surfaceContractId:surface.contract.contractId}:{}),state:record.state}];});}
  runs():readonly PrivateE2ERunView[]{return this.store.listE2ERuns().filter(run=>run.releaseSha===this.options.releaseSha&&this.options.allowedAccountIds.has(run.accountId)).map(run=>{let intent;try{intent=this.store.getIntent(intentIdFromRun(run.runId,this.options.releaseSha))?.intent;}catch{}const attempt=intent?this.store.listPublishAttempts(intent.intentId).at(-1):undefined;const provenance=intent?this.provenance.getIntent(intent.intentId)?.envelope.provenance:undefined,surface=intent&&provenance?this.surfaces.latestContract(intent.accountId,provenance.postingProfileId):null;return{run,gates:this.store.listE2EGateResults(run.runId),...(intent?{intent}:{}),...(attempt?{attempt}:{}),...(provenance?{routeId:provenance.routeId}:{}),...(surface?{surfaceContractId:surface.contract.contractId}:{})};});}
  start(intentId:string,note:string|undefined,now:string):PrivateE2ERun{const record=this.store.getIntent(intentId);if(!record||record.state!=="SCHEDULED")throw new Error(`Private E2E requires SCHEDULED intent ${intentId}`);this.assertAllowed(record.intent.accountId);this.route(intentId);return this.runService.start({runId:runIdFor(intentId,this.options.releaseSha),accountId:record.intent.accountId,platform:record.intent.platform,releaseSha:this.options.releaseSha,now,operatorId:this.operatorId,zeroViewerRequired:true,...(note?.trim()?{note:note.trim()}:{})},this.actor());}
  async syncEvidence(runId:string,now:string):Promise<PrivateE2ERunView>{
    const {run,record}=this.intentForRun(runId),at=new Date(now).toISOString(),preflight=await this.preflight.check(at);this.recordGate(run,"HOST_PREFLIGHT",preflight.ready?"PASS":"FAIL",preflight.checkedAt,preflight.ready?"host preflight passed":"host preflight failed",[],{checks:preflight.checks});
    const identities=this.store.listBrowserIdentities().map(item=>item.identity).filter(item=>item.accountId===record.intent.accountId&&item.enabled),identity=identities.length===1?identities[0]:undefined,health=identity?this.store.latestSessionHealth(identity.identityId):null;
    this.recordGate(run,"SESSION_HEALTH",health?.state==="HEALTHY"?"PASS":"FAIL",health?.checkedAt??at,health?.state==="HEALTHY"?`session ${identity!.identityId} healthy`:`session health ${health?.state??"UNKNOWN"}`);
    try{if(!identity)throw new Error(`expected exactly one enabled identity; found ${identities.length}`);new AccountIdentityGuard(this.store).assertReady(identity.identityId);this.recordGate(run,"IDENTITY_GUARD","PASS",health?.checkedAt??at,`identity @${record.intent.accountId} guard passed`);}catch(error){this.recordGate(run,"IDENTITY_GUARD","FAIL",at,error instanceof Error?error.message:String(error));}
    const surface=this.surface(record.intent.intentId);this.recordGate(run,"UI_CALIBRATION",surface?.contract.status==="CALIBRATED"?"PASS":"FAIL",surface?.recordedAt??at,surface?.contract.status==="CALIBRATED"?`surface ${surface.contract.contractId} calibrated`:`surface ${surface?.contract.status??"MISSING"}`);
    if(surface){for(const replay of this.surfaces.listReplays(surface.contract.contractId).filter(item=>item.passed&&item.reachedFinalActionBoundary&&!item.finalActionInvoked&&item.environmentFingerprint===surface.contract.environment.fingerprint).slice(-3)){this.recordGate(run,"PREPARE_ONLY_REPLAY","PASS",replay.checkedAt,`surface replay ${replay.replayId} passed`,replay.artifactRefs,{replayId:replay.replayId,surfaceContractId:surface.contract.contractId});}}
    return this.runs().find(view=>view.run.runId===runId)!;
  }
  attestPrivacy(runId:string,input:{accountPrivate:boolean;approvedFollowers:number;contactsSyncOff:boolean;crossPostingOff:boolean;testMediaOnly:boolean},now:string):void{this.intentForRun(runId);this.runService.attestPrivacy(runId,input,new Date(now).toISOString(),this.operatorId,this.actor());}
  async prepare(runId:string,now:string){const {run,record}=this.intentForRun(runId);await this.syncEvidence(runId,now);const attempt=await this.publisher.prepare.prepare(record.intent.intentId,new Date(now).toISOString(),this.actor()),retained=this.publisher.registry.get(attempt.attemptId);this.recordGate(run,"FINAL_ACTION_CALIBRATION","PASS",now,"canonical surface preparation reached final-action boundary",attempt.preparationArtifactRefs??[],{attemptId:attempt.attemptId,surfaceContractId:retained.surfaceContractId});return attempt;}
  async invokeFinal(runId:string,confirm:string,now:string):Promise<string>{
    if(confirm!=="PRIVATE_E2E_FINAL_ACTION")throw new Error("Final action requires exact confirmation PRIVATE_E2E_FINAL_ACTION");const {run,record}=this.intentForRun(runId);await this.syncEvidence(runId,now);const attempt=this.store.listPublishAttempts(record.intent.intentId).filter(item=>this.publisher.registry.has(item.attemptId)).at(-1);if(!attempt)throw new Error("No retained prepared session exists for this E2E run");const surfaceId=this.publisher.registry.get(attempt.attemptId).surfaceContractId,context:PublishContext={mode:"test_account",allowFinalPublish:true,allowedAccountIds:new Set([record.intent.accountId]),releaseSha:this.options.releaseSha};const issued=this.permitService.issue({runId,intent:record.intent,context,now:new Date(now).toISOString(),operatorId:this.operatorId,ttlSeconds:120},this.actor());
    const outcome=await this.finalController.execute({runId,permitId:issued.permit.permitId,permitToken:issued.token,intentId:record.intent.intentId,attemptId:attempt.attemptId,context,workerId:`${this.operatorId}:final`,now:new Date(now).toISOString(),actor:this.actor()});const status=outcome.kind==="invoked"?"PASS":"FAIL",gate=this.recordGate(run,"PRIVATE_PUBLISH",status,now,outcome.kind==="invoked"?"private E2E final action invoked once":"private E2E final action outcome uncertain",attempt.preparationArtifactRefs??[],{attemptId:attempt.attemptId,surfaceContractId:surfaceId,outcome:outcome.kind});return gate.summary;
  }
  async verify(runId:string,now:string):Promise<string>{const {run,record}=this.intentForRun(runId),attempt=this.store.listPublishAttempts(record.intent.intentId).at(-1);if(!attempt)throw new Error("Private E2E has no publish attempt to verify");const result=await this.publisher.reconciliation.reconcile(record.intent.intentId,attempt.attemptId,this.actor()),passed=result.decision.outcome==="VERIFIED",gate=this.recordGate(run,"VERIFICATION",passed?"PASS":"FAIL",now,`verification ${result.decision.outcome}`,[],{decisionId:result.decision.decisionId,collectorErrors:result.collectorErrors});return gate.summary;}
  confirmCleanup(runId:string,confirm:string,note:string,now:string):void{if(confirm!=="PRIVATE_E2E_TEST_POST_DELETED")throw new Error("Cleanup requires exact confirmation PRIVATE_E2E_TEST_POST_DELETED");if(!note.trim())throw new Error("Cleanup confirmation requires a note/evidence reference");const {run,record}=this.intentForRun(runId);if(record.state!=="VERIFIED")throw new Error(`Cleanup confirmation requires VERIFIED intent, got ${record.state}`);this.recordGate(run,"CLEANUP","PASS",now,"operator confirmed private test post deleted",[],{manual:true,note:note.trim()});this.store.setE2ERunStatus(runId,"PASSED",new Date(now).toISOString(),this.actor(),`cleanup confirmed: ${note.trim()}`);}
  async cancelPrepared(runId:string,now:string):Promise<void>{const {run,record}=this.intentForRun(runId),attempt=this.store.listPublishAttempts(record.intent.intentId).filter(item=>this.publisher.registry.has(item.attemptId)).at(-1);if(!attempt)return;await this.publisher.registry.close(attempt.attemptId);const current=this.store.getIntent(record.intent.intentId);if(current?.state==="PREPARING")this.store.transitionIntent(record.intent.intentId,"SCHEDULED",new Date(now).toISOString(),this.actor(),"private_e2e_prepare_cancelled_before_boundary");this.recordGate(run,"FINAL_ACTION_CALIBRATION","FAIL",now,"prepared private E2E session cancelled before final action",attempt.preparationArtifactRefs??[],{attemptId:attempt.attemptId});}
  async close():Promise<void>{await this.publisher.close();this.routeEvidence.close();this.surfaces.close();this.provenance.close();this.store.close();}
}
