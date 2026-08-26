import type { Instant } from "../domain/model.js";
import type { AuditEvent, ControlPlaneSummary, StoredPublicationIntent } from "../domain/control-plane.js";
import type { ControlPlaneReadPort, EventLogPort, PublicationIntentStorePort, ScheduleStorePort } from "../domain/control-plane-ports.js";

export interface IntentAdminView {
  record: StoredPublicationIntent;
  reservation: ReturnType<ScheduleStorePort["getReservationForIntent"]>;
  lastEvent: AuditEvent | null;
}

export class ControlPlaneAdminReadModel {
  constructor(private readonly store: PublicationIntentStorePort & ScheduleStorePort & EventLogPort & ControlPlaneReadPort) {}

  summary(now: Instant): ControlPlaneSummary {
    return this.store.summary(now);
  }

  intents(): readonly IntentAdminView[] {
    return this.store.listIntents().map((record) => {
      const events = this.store.listEvents("publication_intent", record.intent.intentId);
      return {
        record,
        reservation: this.store.getReservationForIntent(record.intent.intentId),
        lastEvent: events.length > 0 ? events[events.length - 1] ?? null : null
      };
    });
  }

  events(intentId: string): readonly AuditEvent[] {
    return this.store.listEvents("publication_intent", intentId);
  }
}
