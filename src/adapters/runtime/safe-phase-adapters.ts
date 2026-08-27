import type { BrowserIdentityStorePort } from "../../domain/browser-identity-ports.js";
import type { ControlPlaneStorePort, ScheduleStorePort } from "../../domain/control-plane-ports.js";
import type { DistributionConfigurationStorePort } from "../../domain/distribution-ports.js";
import type { DistributionRuntimeStateStorePort } from "../../domain/distribution-runtime-ports.js";
import type { IngressStorePort } from "../../domain/ingress-ports.js";
import type { OperationsStorePort } from "../../domain/operations-ports.js";
import type { PublishAttemptStorePort } from "../../domain/verification-ports.js";
import type { RuntimeDueExecutionPort, RuntimeOperationsPort, RuntimeReconciliationPort } from "../../domain/runtime-supervisor-ports.js";
import { RestartRecoveryService } from "../../application/recovery.js";
import { OperationsCycleService, OperationsIncidentProjector } from "../../application/operations.js";
import { projectContentDemand } from "../../application/content-demand.js";
import { planReadinessAttention } from "../../application/readiness-notification-planner.js";
import { notificationForAttention } from "../../application/attention-notifications.js";
import { businessDateForInstant } from "../../domain/scheduling.js";
import { DEFAULT_DISTRIBUTION_RUNTIME_POLICY } from "../../domain/distribution-operations.js";

/** R0 safety adapter: observes due work but never acquires a publication lease or changes intent state. */
export class FrozenRuntimeDueExecutionAdapter implements RuntimeDueExecutionPort {
  constructor(private readonly schedules:ScheduleStorePort){}
  async runDue(now:string){
    const frozen=this.schedules.listDueReservations(new Date(now).toISOString()).length;
    return{claimed:0,prepared:0,verified:0,uncertain:0,blocked:0,frozen};
  }
}

type RecoveryRuntimeStore=ControlPlaneStorePort & Partial<Pick<PublishAttemptStorePort,"listPublishAttempts"|"markAttemptUncertain">>;

/**
 * R0 reconciliation performs only durable restart repair. It never collects platform absence/presence
 * evidence and therefore can never return SAFE_TO_RETRY. PREPARING before an irreversible boundary
 * rolls back safely after lease expiry; PUBLISHING/VERIFYING become PUBLISH_UNCERTAIN.
 */
export class RecoveryOnlyRuntimeReconciliationAdapter implements RuntimeReconciliationPort {
  private readonly recovery:RestartRecoveryService;
  constructor(private readonly store:RecoveryRuntimeStore){this.recovery=new RestartRecoveryService(store);}
  async reconcile(now:string){
    const timestamp=new Date(now).toISOString(),beforeUncertain=this.store.listIntents(["PUBLISH_UNCERTAIN"]).map(record=>record.intent.intentId),beforeRecoverable=this.store.listIntents(["PREPARING","PUBLISHING","VERIFYING"]).map(record=>record.intent.intentId);
    const report=this.recovery.recover(timestamp,{type:"system",id:"runtime-recovery"});
    const inspectedIds=[...new Set([...beforeUncertain,...beforeRecoverable,...report.safePrepareRollbacks,...report.uncertainMarked,...report.skippedWithActiveLease])];
    const stillUncertain=this.store.listIntents(["PUBLISH_UNCERTAIN"]).length;
    return{inspected:inspectedIds.length,verified:0,safeToRetry:0,stillUncertain};
  }
}

type RuntimeOperationsStore = ControlPlaneStorePort & BrowserIdentityStorePort & IngressStorePort & OperationsStorePort;

export interface W6RuntimeOperationsOptions {
  distributionConfig?: DistributionConfigurationStorePort;
  distributionRuntime?: DistributionRuntimeStateStorePort;
  uiBaseUrl?: string;
}

/** Maps the runtime phase onto the already-existing W6 incident/outbox rules. */
export class W6RuntimeOperationsAdapter implements RuntimeOperationsPort {
  constructor(
    private readonly store:RuntimeOperationsStore,
    private readonly channelKeys:readonly string[],
    private readonly timeZone:string="Europe/Vienna",
    private readonly options:W6RuntimeOperationsOptions={}
  ){}

  async projectAndNotify(now:string){
    const timestamp=new Date(now).toISOString();
    const before=this.store.listNotificationDeliveries().length;
    let incidentsCreated=0;
    if(this.channelKeys.length===0){
      const projection=new OperationsIncidentProjector(this.store).project(timestamp,{type:"system",id:"runtime-operations"});
      incidentsCreated=projection.created;
    }else{
      const report=new OperationsCycleService(this.store,{channelKeys:this.channelKeys,timeZone:this.timeZone})
        .run(timestamp,{type:"system",id:"runtime-operations"});
      incidentsCreated=report.projection.created;
    }

    if(this.channelKeys.length>0&&this.options.distributionConfig&&this.options.distributionRuntime){
      const stored=this.options.distributionConfig.load();
      const readinessPolicy=stored.runtimePolicy?.readiness??DEFAULT_DISTRIBUTION_RUNTIME_POLICY.readiness;
      const businessDate=businessDateForInstant(timestamp,readinessPolicy.timeZone);
      const plan=this.options.distributionRuntime.latestDailyPlan(businessDate)?.plan;
      if(plan){
        const assets=this.options.distributionRuntime.listAssets().map((record)=>record.asset);
        const demand=projectContentDemand(stored,assets,businessDate,plan);
        for(const timed of planReadinessAttention({now:timestamp,businessDate,stored,demand,plan,policy:readinessPolicy})){
          const message=notificationForAttention(timed.attention,timestamp,{notify:{INFO:false,WARNING:true,ACTION_REQUIRED:true,CRITICAL:true},...(this.options.uiBaseUrl?{uiBaseUrl:this.options.uiBaseUrl}:{})});
          if(message)this.store.enqueueNotification(message,this.channelKeys,{type:"system",id:"runtime-readiness"});
        }
      }
    }

    const after=this.store.listNotificationDeliveries().length;
    return{incidentsCreated,notificationsEnqueued:Math.max(0,after-before)};
  }
}
