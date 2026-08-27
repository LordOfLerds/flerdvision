import type {
  DailyPlanProvenance,
  DistributionPublicationIntentEnvelope,
  StoredDailyPlanProvenance,
  StoredDistributionIntentEnvelope
} from "./distribution-provenance.js";

export interface DistributionProvenanceStorePort {
  putPlan(provenance: DailyPlanProvenance, now: string): { created: boolean; record: StoredDailyPlanProvenance };
  getPlan(planId: string): StoredDailyPlanProvenance | null;
  putIntent(envelope: DistributionPublicationIntentEnvelope, now: string): { created: boolean; record: StoredDistributionIntentEnvelope };
  getIntent(intentId: string): StoredDistributionIntentEnvelope | null;
  getIntentByDelivery(deliveryId: string): StoredDistributionIntentEnvelope | null;
}
