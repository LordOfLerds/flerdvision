import { createHash } from "node:crypto";
import { AccountIdentityGuard, BrowserSessionHealthService } from "../../application/browser-identity-service.js";
import { buildPlatformExecutionPlan } from "../../application/platform-execution-plan.js";
import type { DistributionPostingContextResolverPort } from "../../domain/distribution-publish-ports.js";
import type { PlatformSurfaceStorePort } from "../../domain/platform-surface-ports.js";
import type { BrowserIdentityStorePort, BrowserPageSessionPort, BrowserProfileLock, BrowserProfileLockPort, BrowserRuntimePort, SessionProbePort } from "../../domain/browser-identity-ports.js";
import type { Actor } from "../../domain/control-plane.js";
import type { PublicationIntentStorePort } from "../../domain/control-plane-ports.js";
import type { IngressStorePort } from "../../domain/ingress-ports.js";
import type { LocalMediaArtifact, UiLocator } from "../../domain/platform-ui.js";
import { composePostedCaption } from "../../domain/platform-ui.js";
import type { MediaMaterializerPort, PrepareArtifactSinkPort, PublicationPayloadResolverPort } from "../../domain/platform-ui-ports.js";
import type { PublicationIntent, PublishAttempt, VerificationEvidence } from "../../domain/model.js";
import type { FinalActionInvokerPort, PublishAttemptStorePort } from "../../domain/verification-ports.js";
import { BrowserCalibrationRecorder } from "../browser/calibration-recorder.js";
import { BrowserDomUiDriver } from "../browser/dom-ui-driver.js";
import { SafePlatformExecutionRunner } from "../browser/platform-execution-runner.js";
import { beginScreencast, type RunRecording } from "../browser/screencast-recorder.js";

export class SurfacePublishSessionError extends Error {}
type SurfacePublishStore = PublicationIntentStorePort & PublishAttemptStorePort & BrowserIdentityStorePort & IngressStorePort;
export type SessionProbeResolver = (intent:PublicationIntent)=>SessionProbePort;
function attemptId(intentId:string,at:string):string{return`attempt:${createHash("sha256").update(`${intentId}|${at}|${Math.random()}`).digest("hex").slice(0,24)}`;}
function evidenceId(intentId:string,attemptIdValue:string,at:string):string{return`evidence:${createHash("sha256").update(`${intentId}|${attemptIdValue}|${at}|surface-final-click`).digest("hex").slice(0,24)}`;}
function finalLocators(plan:ReturnType<typeof buildPlatformExecutionPlan>):readonly UiLocator[]{const final=plan.actions.at(-1);if(!final||final.operation!=="FINAL_BOUNDARY")throw new SurfacePublishSessionError("Canonical execution plan does not terminate at FINAL_BOUNDARY");return final.locators;}

export interface RetainedSurfacePublishSession {attempt:PublishAttempt;intent:PublicationIntent;identityId:string;surfaceContractId:string;environmentFingerprint:string;session:BrowserPageSessionPort;finalActionLocators:readonly UiLocator[];capture?(label:string):Promise<readonly string[]>;close():Promise<void>;}
export class RetainedSurfacePublishSessionRegistry {
  private readonly sessions=new Map<string,RetainedSurfacePublishSession>();
  add(session:RetainedSurfacePublishSession):void{if(this.sessions.has(session.attempt.attemptId))throw new SurfacePublishSessionError(`Retained surface session already exists for ${session.attempt.attemptId}`);this.sessions.set(session.attempt.attemptId,session);}
  get(attemptIdValue:string):RetainedSurfacePublishSession{const session=this.sessions.get(attemptIdValue);if(!session)throw new SurfacePublishSessionError(`No retained surface session for ${attemptIdValue}`);return session;}
  has(attemptIdValue:string):boolean{return this.sessions.has(attemptIdValue);}
  async close(attemptIdValue:string):Promise<void>{const session=this.sessions.get(attemptIdValue);if(!session)return;this.sessions.delete(attemptIdValue);await session.close();}
  async closeAll():Promise<void>{for(const id of [...this.sessions.keys()])await this.close(id);}
}

export interface SurfacePublishPreparationOptions {releaseSha:string;ownerId:string;headless?:boolean;now?:()=>string;}
export class SurfacePublishPreparationService {
  private readonly now:()=>string;
  constructor(private readonly store:SurfacePublishStore,private readonly contextResolver:DistributionPostingContextResolverPort,private readonly surfaces:PlatformSurfaceStorePort,private readonly browser:BrowserRuntimePort,private readonly profileLocks:BrowserProfileLockPort,private readonly sessionProbe:SessionProbeResolver,private readonly payloads:PublicationPayloadResolverPort,private readonly media:MediaMaterializerPort,private readonly artifacts:PrepareArtifactSinkPort,private readonly registry:RetainedSurfacePublishSessionRegistry,private readonly options:SurfacePublishPreparationOptions){if(!options.releaseSha.trim())throw new SurfacePublishSessionError("Surface preparation requires releaseSha");this.now=options.now??(()=>new Date().toISOString());}
  async prepare(intentIdValue:string,at:string,actor:Actor):Promise<PublishAttempt>{return await this.prepareInternal(intentIdValue,at,actor,false);}
  async prepareClaimed(intentIdValue:string,at:string,actor:Actor):Promise<PublishAttempt>{return await this.prepareInternal(intentIdValue,at,actor,true);}
  private async prepareInternal(intentIdValue:string,at:string,actor:Actor,alreadyClaimed:boolean):Promise<PublishAttempt>{
    const startedAt=new Date(at).toISOString(),record=this.store.getIntent(intentIdValue);if(!record)throw new SurfacePublishSessionError(`Unknown publication intent: ${intentIdValue}`);
    const expected=alreadyClaimed?"PREPARING":"SCHEDULED";if(record.state!==expected)throw new SurfacePublishSessionError(`Surface preparation expected ${expected} intent, got ${record.state}`);
    const context=this.contextResolver.resolve(record.intent),surface=this.surfaces.latestContract(record.intent.accountId,context.postingProfile.postingProfileId);if(!surface||surface.contract.status!=="CALIBRATED")throw new SurfacePublishSessionError(`Intent ${intentIdValue} requires a CALIBRATED surface contract`);
    const identities=this.store.listBrowserIdentities().map(item=>item.identity).filter(item=>item.accountId===record.intent.accountId&&item.enabled);if(identities.length!==1)throw new SurfacePublishSessionError(`Account ${record.intent.accountId} requires exactly one enabled browser identity; found ${identities.length}`);
    const identity=identities[0]!;if(identity.platform!==record.intent.platform)throw new SurfacePublishSessionError("Browser identity platform differs from publication intent");
    const plan=buildPlatformExecutionPlan(context,surface.contract),probe=this.sessionProbe(record.intent),payload=await this.payloads.resolve(record.intent),content=this.store.getContentItem(record.intent.contentId)?.item;if(!content)throw new SurfacePublishSessionError(`Content ${record.intent.contentId} not found`);
    if(!alreadyClaimed)this.store.transitionIntent(intentIdValue,"PREPARING",startedAt,actor,"surface_prepare_started");
    let lock:BrowserProfileLock|null=null,page:BrowserPageSessionPort|undefined,materialized:LocalMediaArtifact|undefined,retained=false,recording:RunRecording|null=null;
    const close=async()=>{try{if(page)await page.close().catch(()=>{});}finally{try{if(materialized&&this.media.release)await this.media.release(materialized).catch(()=>{});}finally{lock?.release();lock=null;}}};
    try{
      lock=this.profileLocks.acquire(identity,this.options.ownerId,startedAt);page=await this.browser.launch(identity,{headless:this.options.headless??true,initialUrl:"about:blank"});
      // Optional evidence only, started as soon as there is a browser to record and always
      // stopped again below: the whole prepare leg -- login readback, upload, every setting --
      // ends up in one MP4 beside this intent's screenshots. Nothing here can fail the prepare.
      recording=await beginScreencast(page,this.artifacts.recordingDirectory?.(record.intent),`screencast-prepare-${record.intent.platform}`);
      await new BrowserSessionHealthService(this.store,probe).check(identity.identityId,page,this.now(),actor);new AccountIdentityGuard(this.store).assertReady(identity.identityId);materialized=await this.media.materialize(content);
      const caption=composePostedCaption(payload);
      const execution=await new SafePlatformExecutionRunner(page,this.artifacts,this.now).execute(plan,identity,{mediaPath:materialized.localPath,...(caption!==undefined?{caption}:{}),...(payload.title!==undefined?{title:payload.title}:{})});
      if(!execution.reachedFinalActionBoundary||execution.finalActionInvoked)throw new SurfacePublishSessionError("Surface preparation did not stop safely at final boundary");if(execution.environmentFingerprint!==surface.contract.environment.fingerprint)throw new SurfacePublishSessionError("Surface environment changed during preparation");
      const recordedPath=await recording?.stop()??null;recording=null;
      const attempt:PublishAttempt={attemptId:attemptId(intentIdValue,startedAt),intentId:intentIdValue,browserIdentityId:identity.identityId,releaseSha:this.options.releaseSha,startedAt,finishedAt:new Date(this.now()).toISOString(),result:"prepared",mediaSha256:materialized.sha256,preparationArtifactRefs:[...execution.artifactRefs,...(recordedPath?[recordedPath]:[])],reachedFinalActionBoundary:true};
      const capturePage=page,captureIdentity=identity,capture=async(label:string):Promise<readonly string[]>=>{try{return await this.artifacts.captureBoundary(capturePage,record.intent,captureIdentity,label,this.now());}catch{return[];}};
      const storedAttempt=this.store.recordPreparedAttempt(attempt,actor),retainedSession:RetainedSurfacePublishSession={attempt:storedAttempt,intent:record.intent,identityId:identity.identityId,surfaceContractId:surface.contract.contractId,environmentFingerprint:surface.contract.environment.fingerprint,session:page,finalActionLocators:finalLocators(plan),capture,close};this.registry.add(retainedSession);retained=true;return storedAttempt;
    }catch(error){await recording?.stop();if(!retained)await close();const current=this.store.getIntent(intentIdValue);if(current?.state==="PREPARING")this.store.transitionIntent(intentIdValue,"BLOCKED",new Date(this.now()).toISOString(),actor,`surface_prepare_failed:${error instanceof Error?error.message:String(error)}`);throw error;}
  }
}

export class RetainedSurfaceFinalActionInvoker implements FinalActionInvokerPort {
  private readonly recorder=new BrowserCalibrationRecorder();
  constructor(private readonly registry:RetainedSurfacePublishSessionRegistry,private readonly now:()=>string=()=>new Date().toISOString(),private readonly settleOptions:{deadlineMs?:number;pollMs?:number}={}){}
  async invoke(intent:PublicationIntent,attempt:PublishAttempt):Promise<{invokedAt:string;finishedAt:string;evidence:readonly VerificationEvidence[]}>{
    const retained=this.registry.get(attempt.attemptId);if(retained.intent.intentId!==intent.intentId||attempt.intentId!==intent.intentId)throw new SurfacePublishSessionError("Retained surface session intent mismatch");if(retained.identityId!==attempt.browserIdentityId)throw new SurfacePublishSessionError("Retained surface session browser identity mismatch");if(attempt.releaseSha!==retained.attempt.releaseSha)throw new SurfacePublishSessionError("Retained surface session release mismatch");
    const environment=await this.recorder.environment(retained.session);if(environment.fingerprint!==retained.environmentFingerprint)throw new SurfacePublishSessionError("Surface environment changed before final action");const invokedAt=new Date(this.now()).toISOString();
    try{
      const descriptor=await new BrowserDomUiDriver(retained.session).clickIrreversible(retained.finalActionLocators,10_000);
      // The platform's share is asynchronous: the page keeps uploading/finalizing AFTER the
      // click and only then submits. Tearing the session down in the same millisecond killed
      // the in-flight share on the first live attempt (click invoked, no post, UNCERTAIN
      // forever, zero post-click evidence). The session now stays alive until the surface
      // shows a definitive signal or a hard deadline passes, with evidence captured either way.
      const clickRefs=await(retained.capture?.("final-action-clicked")??Promise.resolve([]));
      const settlement=await this.settle(retained.session,this.settleOptions.deadlineMs,this.settleOptions.pollMs);
      const settleRefs=await(retained.capture?.(settlement.settled?"final-action-settled":"final-action-settle-timeout")??Promise.resolve([]));
      const finishedAt=new Date(this.now()).toISOString();
      return{invokedAt,finishedAt,evidence:[
        {evidenceId:evidenceId(intent.intentId,attempt.attemptId,invokedAt),intentId:intent.intentId,attemptId:attempt.attemptId,kind:"ui_receipt",observedAt:invokedAt,positive:true,locator:descriptor,...(clickRefs[0]?{artifactRef:clickRefs[0]}:{}),note:`Final UI action invoked from CALIBRATED SurfaceContract ${retained.surfaceContractId}; receipt alone is not verification of publication.`},
        {evidenceId:evidenceId(intent.intentId,attempt.attemptId,finishedAt),intentId:intent.intentId,attemptId:attempt.attemptId,kind:"ui_receipt",observedAt:finishedAt,positive:settlement.settled,...(settleRefs[0]?{artifactRef:settleRefs[0]}:{}),note:settlement.note}
      ]};
    }finally{await this.registry.close(attempt.attemptId);}
  }

  /**
   * Bounded post-click settlement: poll until the create dialog is gone or the surface shows a
   * success phrase. Navigation away (destroyed context) counts as the dialog closing. Never
   * clicks anything; read-only observation with a hard deadline.
   */
  private async settle(session:BrowserPageSessionPort,deadlineMs:number=90_000,pollMs:number=1_500):Promise<{settled:boolean;note:string}>{
    const startedAt=Date.now();
    let last="";
    while(Date.now()-startedAt<deadlineMs){
      try{
        const state=await session.evaluate<{dialog:boolean;success:boolean;progress:boolean}>(`(()=>{const text=(document.body&&document.body.innerText||"");return{dialog:!!document.querySelector('[role="dialog"]'),success:/wurde geteilt|has been shared|was shared|wurde gepostet|has been posted/i.test(text),progress:/wird geteilt|is being shared|wird gepostet/i.test(text)};})()`);
        last=`dialog=${state.dialog} success=${state.success} progress=${state.progress}`;
        if(state.success)return{settled:true,note:`Surface confirmed the share (success phrase visible) after ${Date.now()-startedAt}ms; verification remains authoritative.`};
        if(!state.dialog&&!state.progress)return{settled:true,note:`Create dialog closed with no in-progress indicator after ${Date.now()-startedAt}ms; verification remains authoritative.`};
      }catch(error){
        const message=error instanceof Error?error.message:String(error);
        if(/navigated or closed|execution context was destroyed|cannot find context/i.test(message))return{settled:true,note:`Page navigated away after the final action (${Date.now()-startedAt}ms); treated as dialog closed. Verification remains authoritative.`};
        last=`probe error: ${message}`;
      }
      await new Promise(resolvePoll=>setTimeout(resolvePoll,pollMs));
    }
    return{settled:false,note:`No definitive post-action signal within ${deadlineMs}ms (last observation: ${last}); publication remains uncertain pending verification.`};
  }
}
