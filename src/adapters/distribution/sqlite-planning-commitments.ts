import type { PlanningCommitmentPort } from "../../domain/planning-commitment-ports.js";
import type { DistributionRuntimeStateStorePort } from "../../domain/distribution-runtime-ports.js";
import type { DistributionProvenanceStorePort } from "../../domain/distribution-provenance-ports.js";
import type { PublicationIntentStorePort, ScheduleStorePort } from "../../domain/control-plane-ports.js";
import type { DailyPlanCommitment } from "../../application/daily-plan-commitments.js";

export class PersistedPlanningCommitmentAdapter implements PlanningCommitmentPort {
  constructor(
    private readonly runtime: DistributionRuntimeStateStorePort,
    private readonly provenance: DistributionProvenanceStorePort,
    private readonly control: PublicationIntentStorePort & ScheduleStorePort
  ) {}

  listCommitted(businessDate: string): readonly DailyPlanCommitment[] {
    const plan = this.runtime.latestDailyPlan(businessDate)?.plan;
    if (!plan) return [];
    const out: DailyPlanCommitment[] = [];
    for (const delivery of plan.deliveries) {
      const envelope = this.provenance.getIntentByDelivery(delivery.deliveryId);
      if (!envelope) continue;
      const intentId = envelope.envelope.intent.intentId;
      const reservation = this.control.getReservationForIntent(intentId);
      const intent = this.control.getIntent(intentId);
      if (!reservation || !intent) continue;
      out.push({
        delivery,
        intentId,
        reservationId: reservation.reservationId,
        state: intent.state
      });
    }
    return out.sort((a, b) => a.delivery.scheduledFor.localeCompare(b.delivery.scheduledFor) || a.delivery.deliveryId.localeCompare(b.delivery.deliveryId));
  }
}
