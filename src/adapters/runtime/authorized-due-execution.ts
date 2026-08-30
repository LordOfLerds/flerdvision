import { DurableFinalActionService } from "../../application/durable-final-action.js";
import { DueWorkClaimer, MissedWindowGuard } from "../../application/scheduler.js";
import type { Actor } from "../../domain/control-plane.js";
import type { ControlPlaneStorePort } from "../../domain/control-plane-ports.js";
import type { PublicationIntent } from "../../domain/model.js";
import type { OperationalPublishGatePort } from "../../domain/operations-ports.js";
import type { PublishContext } from "../../domain/ports.js";
import type { RuntimeDueExecutionPort } from "../../domain/runtime-supervisor-ports.js";
import type { FinalActionInvokerPort, PublishAttemptStorePort, VerificationStorePort } from "../../domain/verification-ports.js";
import type { ReconciliationResult } from "../../application/reconciliation.js";

export interface AuthorizedDuePublisherPort {
  prepare:{prepareClaimed(intentId:string,at:string,actor:Actor):Promise<import("../../domain/model.js").PublishAttempt>};
  finalAction:FinalActionInvokerPort;
  reconciliation:{reconcile(intentId:string,attemptId:string,actor:Actor):Promise<ReconciliationResult>};
  registry:{close(attemptId:string):Promise<void>};
}
export type AuthorizedPublishContextProvider=(intent:PublicationIntent)=>PublishContext;
type DueStore=ControlPlaneStorePort & PublishAttemptStorePort & VerificationStorePort;

export interface AuthorizedRuntimeDueExecutionOptions {releaseSha:string;ownerId:string;leaseTtlSeconds?:number;maxPerCycle?:number;clock?:()=>string;}

/**
 * Fully implemented but intentionally NOT wired into WorkspaceDistributionRuntime while R0 is active.
 * Construction still does not authorize publication: caller must inject canary/production context + account allowlist.
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
    this.claimer=new DueWorkClaimer(store,operationalGate);this.missed=new MissedWindowGuard(store);this.finalAction=new DurableFinalActionService(store,publisher.finalAction,this.clock,operationalGate);
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
    const startedAt=new Date(now).toISOString(),actor:Actor={type:"worker",id:this.options.ownerId};let claimed=0,prepared=0,verified=0,uncertain=0,blocked=this.missed.blockMissed(startedAt,actor).length;
    for(let index=0;index<this.maxPerCycle;index++){
      // Allowlist-only eligibility: foreign accounts are another worker's work and must stay
      // SCHEDULED untouched. Misconfiguration (release mismatch, wrong mode) still claims and
      // fails loudly on the existing path -- a broken worker should scream, not idle silently.
      const claim=this.claimer.claimNext(this.options.ownerId,this.clock(),this.leaseTtlSeconds,(intent)=>{
        try{return this.contextProvider(intent).allowedAccountIds.has(intent.accountId);}catch{return true;}
      });if(!claim)break;claimed+=1;let attemptId:string|undefined;
      const heartbeat=()=>{const refreshed=this.store.heartbeatLease(claim.leaseResourceKey,claim.leaseOwnerId,this.clock(),this.leaseTtlSeconds,actor);if(!refreshed)throw new Error(`Lost publication lease ${claim.leaseResourceKey}`);};
      try{
        heartbeat();const attempt=await this.publisher.prepare.prepareClaimed(claim.record.intent.intentId,this.clock(),actor);attemptId=attempt.attemptId;prepared+=1;heartbeat();
        if(attempt.releaseSha!==this.options.releaseSha)throw new Error(`Prepared attempt release ${attempt.releaseSha} differs from worker release ${this.options.releaseSha}`);
        const context=this.context(claim.record.intent),final=await this.finalAction.execute(claim.record.intent.intentId,attempt.attemptId,context,actor);heartbeat();
        if(final.kind==="uncertain"){uncertain+=1;continue;}
        try{const result=await this.publisher.reconciliation.reconcile(claim.record.intent.intentId,attempt.attemptId,actor);if(result.decision.outcome==="VERIFIED")verified+=1;else if(result.decision.outcome==="UNCERTAIN")uncertain+=1;}
        catch(error){const current=this.store.getIntent(claim.record.intent.intentId);if(current?.state==="PUBLISHING"||current?.state==="VERIFYING"){this.store.markAttemptUncertain(attempt.attemptId,this.clock(),actor,`runtime_verification_exception:${error instanceof Error?error.message:String(error)}`);uncertain+=1;}else throw error;}
      }catch(error){
        if(attemptId)await this.publisher.registry.close(attemptId).catch(()=>{});
        const current=this.store.getIntent(claim.record.intent.intentId);
        if(current?.state==="PREPARING"){this.store.transitionIntent(claim.record.intent.intentId,"BLOCKED",this.clock(),actor,`runtime_due_blocked:${error instanceof Error?error.message:String(error)}`);blocked+=1;}
        else if(current?.state==="PUBLISHING"||current?.state==="VERIFYING"){if(attemptId)this.store.markAttemptUncertain(attemptId,this.clock(),actor,`runtime_due_exception:${error instanceof Error?error.message:String(error)}`);uncertain+=1;}
        else if(current?.state==="PUBLISH_UNCERTAIN")uncertain+=1;
        else if(current?.state==="BLOCKED")blocked+=1;
        else throw error;
      }finally{this.store.releaseLease(claim.leaseResourceKey,claim.leaseOwnerId,this.clock(),actor);}
    }
    return{claimed,prepared,verified,uncertain,blocked};
  }
}
