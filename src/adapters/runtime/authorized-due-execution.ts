import { DurableFinalActionService } from "../../application/durable-final-action.js";
import { DueWorkClaimer, MissedWindowGuard, type ClaimedWork } from "../../application/scheduler.js";
import { notifyPublicationOutcomes, type PublicationOutcomeNotificationInput } from "../../application/publication-notifications.js";
import type { OperatorNextSlot } from "../../application/operator-message.js";
import type { NotificationOutboxPort, NotificationPort } from "../../domain/operations-ports.js";
import type { Actor } from "../../domain/control-plane.js";
import type { ControlPlaneStorePort } from "../../domain/control-plane-ports.js";
import type { PublicationIntent } from "../../domain/model.js";
import type { OperationalPublishGatePort } from "../../domain/operations-ports.js";
import type { PublishContext } from "../../domain/ports.js";
import type { RuntimeDueExecutionPort } from "../../domain/runtime-supervisor-ports.js";
import { DEFAULT_SCHEDULING_POLICY, type SchedulingPolicy } from "../../domain/scheduling.js";
import type { FinalActionInvokerPort, PublishAttemptStorePort, VerificationStorePort } from "../../domain/verification-ports.js";
import type { ReconciliationResult } from "../../application/reconciliation.js";

export interface AuthorizedDuePublisherPort {
  prepare:{prepareClaimed(intentId:string,at:string,actor:Actor):Promise<import("../../domain/model.js").PublishAttempt>};
  finalAction:FinalActionInvokerPort;
  reconciliation:{reconcile(intentId:string,attemptId:string,actor:Actor):Promise<ReconciliationResult>};
  registry:{close(attemptId:string):Promise<void>};
}
export type AuthorizedPublishContextProvider=(intent:PublicationIntent)=>PublishContext;
type DueStore=ControlPlaneStorePort & PublishAttemptStorePort & VerificationStorePort & NotificationOutboxPort;

/** What the operator must read in a post message: the video by name, and the copy as posted. */
export interface DuePublicationDescription {videoLabel?:string;hashtags?:string;caption?:string;title?:string;}

export interface AuthorizedRuntimeDueExecutionOptions {releaseSha:string;ownerId:string;leaseTtlSeconds?:number;maxPerCycle?:number;clock?:()=>string;notificationAdapters?:readonly NotificationPort[];timeZone?:string;launchJitterMaxSeconds?:number;channelNames?:Readonly<Record<string,string>>;schedulingPolicy?:SchedulingPolicy;describeContent?:(intent:PublicationIntent)=>Promise<DuePublicationDescription>|DuePublicationDescription;nextSlot?:(now:string)=>OperatorNextSlot|undefined;/** Newest run recording for an intent, attached to its outcome message when present. */findRecording?:(intent:PublicationIntent)=>string|undefined;}

/**
 * Authorized autonomous due worker. Claims at most one intent per account/browser identity in a
 * batch and executes different accounts concurrently. A single social profile is therefore still
 * strictly serial, while a slow YouTube account cannot keep an Instagram/TikTok account from
 * reaching its own terminal state. Construction itself never authorizes publication.
 */
export class AuthorizedRuntimeDueExecutionAdapter implements RuntimeDueExecutionPort {
  private readonly claimer:DueWorkClaimer;
  private readonly missed:MissedWindowGuard;
  private readonly finalAction:DurableFinalActionService;
  private readonly clock:()=>string;
  private readonly leaseTtlSeconds:number;
  private readonly maxPerCycle:number;
  constructor(
    private readonly store:DueStore,
    private readonly publisher:AuthorizedDuePublisherPort,
    private readonly operationalGate:OperationalPublishGatePort,
    private readonly contextProvider:AuthorizedPublishContextProvider,
    private readonly options:AuthorizedRuntimeDueExecutionOptions
  ){
    if(!options.releaseSha.trim())throw new Error("Authorized due execution requires releaseSha");
    if(!options.ownerId.trim())throw new Error("Authorized due execution requires ownerId");
    this.clock=options.clock??(()=>new Date().toISOString());this.leaseTtlSeconds=options.leaseTtlSeconds??900;this.maxPerCycle=options.maxPerCycle??20;
    if(this.leaseTtlSeconds<60)throw new Error("Authorized due execution lease TTL must be at least 60 seconds");if(this.maxPerCycle<1||this.maxPerCycle>100)throw new Error("Authorized due execution maxPerCycle must be 1..100");
    const schedulingPolicy=options.schedulingPolicy??DEFAULT_SCHEDULING_POLICY;
    this.claimer=new DueWorkClaimer(store,operationalGate,schedulingPolicy);this.missed=new MissedWindowGuard(store,schedulingPolicy);this.finalAction=new DurableFinalActionService(store,publisher.finalAction,this.clock,operationalGate);
  }
  private context(intent:PublicationIntent):PublishContext{
    const context=this.contextProvider(intent);
    if(context.mode!=="canary"&&context.mode!=="production")throw new Error(`Authorized runtime worker forbids mode ${context.mode}`);
    if(!context.allowFinalPublish)throw new Error("Authorized runtime worker requires allowFinalPublish=true");
    if(context.releaseSha!==this.options.releaseSha)throw new Error(`Publish context release ${context.releaseSha} differs from worker release ${this.options.releaseSha}`);
    if(!context.allowedAccountIds.has(intent.accountId))throw new Error(`Account ${intent.accountId} is outside authorized runtime allowlist`);
    return context;
  }
  async runDue(now:string){
    const startedAt=new Date(now).toISOString(),actor:Actor={type:"worker",id:this.options.ownerId};
    const waivedIntentIds=this.missed.waiveMissed(startedAt,actor);
    let claimed=0,prepared=0,verified=0,uncertain=0,blocked=0;
    const outcomes:PublicationOutcomeNotificationInput[]=[];
    const unexpectedErrors:unknown[]=[];
    let consumed=0;

    const processClaim=async(claim:ClaimedWork):Promise<void>=>{
      let attemptId:string|undefined;
      const heartbeat=()=>{const refreshed=this.store.heartbeatLease(claim.leaseResourceKey,claim.leaseOwnerId,this.clock(),this.leaseTtlSeconds,actor);if(!refreshed)throw new Error(`Lost publication lease ${claim.leaseResourceKey}`);};
      try{
        heartbeat();const attempt=await this.publisher.prepare.prepareClaimed(claim.record.intent.intentId,this.clock(),actor);attemptId=attempt.attemptId;prepared+=1;heartbeat();
        if(attempt.releaseSha!==this.options.releaseSha)throw new Error(`Prepared attempt release ${attempt.releaseSha} differs from worker release ${this.options.releaseSha}`);
        const context=this.context(claim.record.intent),final=await this.finalAction.execute(claim.record.intent.intentId,attempt.attemptId,context,actor);heartbeat();
        if(final.kind==="uncertain"){uncertain+=1;outcomes.push(await this.outcomeInput(claim.record.intent,attempt.attemptId,"UNCERTAIN"));return;}
        try{
          const result=await this.publisher.reconciliation.reconcile(claim.record.intent.intentId,attempt.attemptId,actor);
          if(result.decision.outcome==="VERIFIED"){verified+=1;outcomes.push(await this.outcomeInput(claim.record.intent,attempt.attemptId,"VERIFIED",result.publication?.permalink));}
          else if(result.decision.outcome==="UNCERTAIN"){uncertain+=1;outcomes.push(await this.outcomeInput(claim.record.intent,attempt.attemptId,"UNCERTAIN"));}
        }catch(error){
          const current=this.store.getIntent(claim.record.intent.intentId);
          if(current?.state==="PUBLISHING"||current?.state==="VERIFYING"){this.store.markAttemptUncertain(attempt.attemptId,this.clock(),actor,`runtime_verification_exception:${error instanceof Error?error.message:String(error)}`);uncertain+=1;}
          else throw error;
        }
      }catch(error){
        if(attemptId)await this.publisher.registry.close(attemptId).catch(()=>{});
        const current=this.store.getIntent(claim.record.intent.intentId);
        if(current?.state==="PREPARING"){this.store.transitionIntent(claim.record.intent.intentId,"BLOCKED",this.clock(),actor,`runtime_due_blocked:${error instanceof Error?error.message:String(error)}`);blocked+=1;}
        else if(current?.state==="PUBLISHING"||current?.state==="VERIFYING"){if(attemptId)this.store.markAttemptUncertain(attemptId,this.clock(),actor,`runtime_due_exception:${error instanceof Error?error.message:String(error)}`);uncertain+=1;}
        else if(current?.state==="PUBLISH_UNCERTAIN")uncertain+=1;
        else if(current?.state==="BLOCKED")blocked+=1;
        else throw error;
      }finally{this.store.releaseLease(claim.leaseResourceKey,claim.leaseOwnerId,this.clock(),actor);}
    };

    while(consumed<this.maxPerCycle){
      const accountsInBatch=new Set<string>();
      const batch:Promise<void>[]=[];
      while(consumed<this.maxPerCycle){
        const claim=this.claimer.claimNext(this.options.ownerId,this.clock(),this.leaseTtlSeconds,(intent)=>{
          if(accountsInBatch.has(intent.accountId))return false;
          try{return this.contextProvider(intent).allowedAccountIds.has(intent.accountId);}catch{return true;}
        },this.options.launchJitterMaxSeconds??0);
        if(!claim)break;
        accountsInBatch.add(claim.record.intent.accountId);claimed+=1;consumed+=1;
        batch.push(processClaim(claim));
      }
      if(batch.length===0)break;
      const settled=await Promise.allSettled(batch);
      for(const result of settled)if(result.status==="rejected")unexpectedErrors.push(result.reason);
      if(unexpectedErrors.length>0)break;
    }

    const nextSlot=(()=>{try{return this.options.nextSlot?.(this.clock());}catch{return undefined;}})();
    await notifyPublicationOutcomes(this.store,this.options.notificationAdapters??[],outcomes,this.clock(),actor,nextSlot?{nextSlot}:{});
    if(unexpectedErrors.length>0)throw new AggregateError(unexpectedErrors,"One or more independent due workers failed unexpectedly");
    return{claimed,prepared,verified,uncertain,blocked,waived:waivedIntentIds.length,waivedIntentIds};
  }

  /** Operator channels hear every post-boundary outcome; a broken channel never breaks the worker. */
  private async outcomeInput(intent:PublicationIntent,attemptId:string,outcome:"VERIFIED"|"UNCERTAIN",permalink?:string):Promise<PublicationOutcomeNotificationInput>{
    const evidence=this.store.listVerificationEvidence(intent.intentId,attemptId).filter(item=>item.positive).at(-1);
    let described:DuePublicationDescription={};
    try{described=await this.options.describeContent?.(intent)??{};}catch{described={};}
    let videoPath:string|undefined;try{videoPath=this.options.findRecording?.(intent);}catch{videoPath=undefined;}
    return{intent,runId:`due:${this.options.ownerId}`,outcome,...(this.options.timeZone?{timeZone:this.options.timeZone}:{}),...(this.options.channelNames?.[intent.accountId]?{channelName:this.options.channelNames[intent.accountId]!}:{}),...(permalink?{permalink}:evidence?.locator?{permalink:evidence.locator}:{}),...(evidence?.artifactRef?{screenshotPath:evidence.artifactRef}:{}),...(described.videoLabel?{videoLabel:described.videoLabel}:{}),...(described.hashtags?{hashtags:described.hashtags}:{}),...(described.caption?{caption:described.caption}:{}),...(described.title?{title:described.title}:{}),...(videoPath?{videoPath}:{})};
  }
}
