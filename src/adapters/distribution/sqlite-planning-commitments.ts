import type { PlanningCommitmentPort } from "../../domain/planning-commitment-ports.js";
import type { DistributionRuntimeStateStorePort } from "../../domain/distribution-runtime-ports.js";
import type { DistributionProvenanceStorePort } from "../../domain/distribution-provenance-ports.js";
import type { PublicationIntentStorePort, ScheduleStorePort } from "../../domain/control-plane-ports.js";
import type { PublishAttemptStorePort } from "../../domain/verification-ports.js";
import type { DailyPlanCommitment } from "../../application/daily-plan-commitments.js";

export class PersistedPlanningCommitmentAdapter implements PlanningCommitmentPort {
  constructor(
    private readonly runtime: DistributionRuntimeStateStorePort,
    private readonly provenance: DistributionProvenanceStorePort,
    private readonly control: PublicationIntentStorePort & ScheduleStorePort & PublishAttemptStorePort
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
      // A BLOCKED intent that provably never reached a publish attempt is planning-dead: keeping
      // its commitment would pin the stale delivery into every replan of the day and conflict
      // against a recompiled config, permanently starving the asset (found live: a missed-window
      // intent plus a same-day schedule change ended every later cycle in a provenance conflict).
      // Any recorded attempt keeps the pin -- a post-attempt block may have published, and
      // replanning that asset could double-post. The blocked intent itself stays as audit.
      if (intent.state === "BLOCKED" && this.control.listPublishAttempts(intentId).length === 0) continue;
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
