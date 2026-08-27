import type { Actor, ScheduleReservation } from "../domain/control-plane.js";
import type { PublicationIntentStorePort, ScheduleStorePort } from "../domain/control-plane-ports.js";
import type { DistributionConfigurationStorePort } from "../domain/distribution-ports.js";
import type { DailyPlan, PlannedDelivery } from "../domain/distribution.js";
import type { DistributionProvenanceStorePort } from "../domain/distribution-provenance-ports.js";
import type { DistributionPublicationIntentEnvelope } from "../domain/distribution-provenance.js";
import type { RouteExecutionQualificationPort } from "../domain/route-execution-ports.js";
import { publicationIntentForDelivery } from "./distribution-planner.js";
import { assertPlanRouteStillCurrent, captureDailyPlanProvenance } from "./distribution-plan-provenance.js";

export interface DistributionIntentMaterializationIssue { deliveryId: string; routeId: string; reason: string; }
export interface DistributionIntentMaterializationReport { created: number; existing: number; blocked: number; issues: readonly DistributionIntentMaterializationIssue[]; }

function sameReservation(reservation: ScheduleReservation, delivery: PlannedDelivery): boolean {
  return reservation.intentId === publicationIntentForDelivery(delivery).intentId && reservation.accountId === delivery.accountId && reservation.platform === delivery.platform && reservation.businessDate === delivery.businessDate && reservation.slotKey === delivery.slotKey && reservation.targetAt === new Date(delivery.scheduledFor).toISOString() && reservation.windowStartAt === new Date(delivery.windowStartAt).toISOString() && reservation.windowEndAt === new Date(delivery.windowEndAt).toISOString();
}
function reservationFor(delivery: PlannedDelivery, intentId: string, now: string): ScheduleReservation {
  return { reservationId:`reservation:${intentId}`, intentId, accountId:delivery.accountId, platform:delivery.platform, businessDate:delivery.businessDate, slotKey:delivery.slotKey, targetAt:new Date(delivery.scheduledFor).toISOString(), windowStartAt:new Date(delivery.windowStartAt).toISOString(), windowEndAt:new Date(delivery.windowEndAt).toISOString(), createdAt:new Date(now).toISOString() };
}

export class DistributionPlanProvenanceService {
  constructor(private readonly config: DistributionConfigurationStorePort, private readonly provenance: DistributionProvenanceStorePort) {}
  capture(plan: DailyPlan, now: string) { return this.provenance.putPlan(captureDailyPlanProvenance(plan, this.config.load(), now), now); }
}

export class DistributionIntentMaterializer {
  constructor(
    private readonly control: PublicationIntentStorePort & ScheduleStorePort,
    private readonly config: DistributionConfigurationStorePort,
    private readonly provenance: DistributionProvenanceStorePort,
    private readonly qualification?: RouteExecutionQualificationPort
  ) {}

  ensureIntents(plan: DailyPlan, now: string, actor: Actor = { type:"system", id:"distribution-intent-materializer" }): DistributionIntentMaterializationReport {
    const planRecord=this.provenance.getPlan(plan.planId);
    if(!planRecord) throw new Error(`DailyPlan ${plan.planId} has no immutable planning provenance; materialization is refused`);
    const current=this.config.load(); let created=0,existing=0,blocked=0; const issues:DistributionIntentMaterializationIssue[]=[];
    for(const delivery of plan.deliveries){
      try{
        const snapshot=assertPlanRouteStillCurrent(planRecord.provenance,delivery.routeId,current);
        if(snapshot.route.accountId!==delivery.accountId||snapshot.route.laneId!==delivery.laneId) throw new Error(`Delivery ${delivery.deliveryId} no longer matches frozen route identity`);
        if(snapshot.postingProfile.postingProfileId!==delivery.postingProfileId||snapshot.postingProfile.format!==delivery.format) throw new Error(`Delivery ${delivery.deliveryId} no longer matches frozen posting profile`);
        if(snapshot.copyProfile.copyProfileId!==delivery.copyProfileId||snapshot.copyProfile.versionId!==delivery.copyVersionId) throw new Error(`Delivery ${delivery.deliveryId} no longer matches frozen copy profile`);
        this.qualification?.assertAllowed(delivery);
        const intent=publicationIntentForDelivery(delivery);
        const envelope:DistributionPublicationIntentEnvelope={intent,provenance:{planId:plan.planId,deliveryId:delivery.deliveryId,routeId:delivery.routeId,laneId:delivery.laneId,assetId:delivery.assetId,postingProfileId:delivery.postingProfileId,copyProfileId:delivery.copyProfileId,schedulePolicyId:snapshot.route.schedulePolicyId,routeSnapshotFingerprint:snapshot.fingerprint,postingProfileSnapshot:snapshot.postingProfile}};
        // Provenance first: a crash can leave inert provenance, never a runnable intent without provenance.
        this.provenance.putIntent(envelope,now);
        const intentResult=this.control.createOrGetIntent(intent,now,actor); let record=intentResult.record;
        if(record.state==="PLANNED") record=this.control.transitionIntent(intent.intentId,"READY",now,actor,"distribution_plan_materialized");
        const existingReservation=this.control.getReservationForIntent(intent.intentId);
        if(existingReservation){ if(!sameReservation(existingReservation,delivery)) throw new Error(`Intent ${intent.intentId} has a reservation that differs from PlannedDelivery ${delivery.deliveryId}`); }
        else if(record.state==="READY") this.control.reserveIntent(intent.intentId,reservationFor(delivery,intent.intentId,now),now,actor);
        else if(record.state!=="SCHEDULED"&&record.state!=="PREPARING"&&record.state!=="PUBLISHING"&&record.state!=="VERIFYING"&&record.state!=="PUBLISH_UNCERTAIN"&&record.state!=="RETRY_WAIT"&&record.state!=="VERIFIED"&&record.state!=="BLOCKED"&&record.state!=="WAIVED") throw new Error(`Intent ${intent.intentId} is in unsupported state ${record.state}`);
        if(intentResult.created)created+=1;else existing+=1;
      }catch(error){blocked+=1;issues.push({deliveryId:delivery.deliveryId,routeId:delivery.routeId,reason:error instanceof Error?error.message:String(error)});}
    }
    return{created,existing,blocked,issues};
  }
}
