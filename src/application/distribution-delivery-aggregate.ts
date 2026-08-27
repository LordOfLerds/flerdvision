import type { PublicationIntentStorePort } from "../domain/control-plane-ports.js";
import type { DistributionProvenanceStorePort } from "../domain/distribution-provenance-ports.js";
import type { DistributionRuntimeStateStorePort } from "../domain/distribution-runtime-ports.js";
import type { DeliveryAggregate, PlannedDelivery } from "../domain/distribution.js";
import type { VerificationStorePort } from "../domain/verification-ports.js";
import { aggregateDeliveryStatus } from "../domain/distribution.js";

export interface DistributionDeliveryTrace {
  delivery: PlannedDelivery;
  intentId?: string;
  intentState?: string;
  publicationId?: string;
  status: "VERIFIED" | "WAIVED" | "FAILED" | "PENDING" | "UNMATERIALIZED";
  reason?: string;
}

export interface ProjectedDeliveryAggregate {
  aggregate: DeliveryAggregate;
  traces: readonly DistributionDeliveryTrace[];
  publicationIds: readonly string[];
}

export class DistributionDeliveryAggregateProjector {
  constructor(
    private readonly runtime: DistributionRuntimeStateStorePort,
    private readonly provenance: DistributionProvenanceStorePort,
    private readonly intents: PublicationIntentStorePort,
    private readonly verification: VerificationStorePort
  ) {}

  project(assetId?: string): readonly ProjectedDeliveryAggregate[] {
    const deliveries = this.runtime.listCurrentDailyPlans()
      .flatMap((record) => record.plan.deliveries)
      .filter((delivery) => !assetId || delivery.assetId === assetId);
    const byAsset = new Map<string, PlannedDelivery[]>();
    for (const delivery of deliveries) {
      const list = byAsset.get(delivery.assetId) ?? [];
      if (!list.some((item) => item.deliveryId === delivery.deliveryId)) list.push(delivery);
      byAsset.set(delivery.assetId, list);
    }

    const out: ProjectedDeliveryAggregate[] = [];
    for (const [currentAssetId, assetDeliveries] of byAsset) {
      const requiredDeliveryIds = assetDeliveries.filter((item) => item.requirement === "REQUIRED").map((item) => item.deliveryId).sort();
      const optionalDeliveryIds = assetDeliveries.filter((item) => item.requirement === "OPTIONAL").map((item) => item.deliveryId).sort();
      const verifiedDeliveryIds: string[] = [];
      const waivedDeliveryIds: string[] = [];
      const failedDeliveryIds: string[] = [];
      const publicationIds: string[] = [];
      const traces: DistributionDeliveryTrace[] = [];

      for (const delivery of [...assetDeliveries].sort((a,b)=>a.scheduledFor.localeCompare(b.scheduledFor)||a.deliveryId.localeCompare(b.deliveryId))) {
        const storedEnvelope = this.provenance.getIntentByDelivery(delivery.deliveryId);
        if (!storedEnvelope) {
          traces.push({ delivery, status: "UNMATERIALIZED", reason: "delivery_has_no_immutable_intent_provenance" });
          continue;
        }
        const intentId = storedEnvelope.envelope.intent.intentId;
        const record = this.intents.getIntent(intentId);
        if (!record) {
          traces.push({ delivery, intentId, status: "UNMATERIALIZED", reason: "provenance_exists_but_control_plane_intent_is_missing" });
          continue;
        }
        const publication = this.verification.getVerifiedPublication(intentId);
        if (publication) {
          verifiedDeliveryIds.push(delivery.deliveryId);
          publicationIds.push(publication.publicationId);
          traces.push({ delivery, intentId, intentState: record.state, publicationId: publication.publicationId, status: "VERIFIED" });
          continue;
        }
        if (record.state === "WAIVED") {
          waivedDeliveryIds.push(delivery.deliveryId);
          traces.push({ delivery, intentId, intentState: record.state, status: "WAIVED" });
          continue;
        }
        if (record.state === "BLOCKED") {
          failedDeliveryIds.push(delivery.deliveryId);
          traces.push({ delivery, intentId, intentState: record.state, status: "FAILED" });
          continue;
        }
        traces.push({ delivery, intentId, intentState: record.state, status: "PENDING" });
      }

      const aggregate = aggregateDeliveryStatus({
        assetId: currentAssetId,
        requiredDeliveryIds,
        optionalDeliveryIds,
        verifiedDeliveryIds: [...new Set(verifiedDeliveryIds)].sort(),
        waivedDeliveryIds: [...new Set(waivedDeliveryIds)].sort(),
        failedDeliveryIds: [...new Set(failedDeliveryIds)].sort()
      });
      out.push({ aggregate, traces, publicationIds: [...new Set(publicationIds)].sort() });
    }
    return out.sort((a,b)=>a.aggregate.assetId.localeCompare(b.aggregate.assetId));
  }
}
