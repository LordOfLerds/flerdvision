import type { Instant } from "../domain/model.js";
import type { AuditEvent, ControlPlaneSummary, StoredPublicationIntent } from "../domain/control-plane.js";
import type { ControlPlaneReadPort, EventLogPort, PublicationIntentStorePort, ScheduleStorePort } from "../domain/control-plane-ports.js";
import type { IngressStorePort } from "../domain/ingress-ports.js";
import type { SourceDispositionRecord, StoredContentItem, StoredSourceObservation } from "../domain/ingress.js";
import type { PublishAttemptStorePort, VerificationStorePort } from "../domain/verification-ports.js";

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

export interface IngressAdminView {
  sources: readonly StoredSourceObservation[];
  content: readonly StoredContentItem[];
  dispositions: readonly SourceDispositionRecord[];
}

export class IngressAdminReadModel {
  constructor(private readonly store: IngressStorePort) {}

  sources(): readonly StoredSourceObservation[] {
    return this.store.listSourceObservations();
  }

  content(): readonly StoredContentItem[] {
    return this.store.listContentItems();
  }

  dispositions(): readonly SourceDispositionRecord[] {
    return this.store.listSourceObservations()
      .map((record) => this.store.getSourceDisposition(record.observation.observationId))
      .filter((record): record is SourceDispositionRecord => record !== null);
  }
}

export interface VerificationAdminView {
  intentId: string;
  attempts: ReturnType<PublishAttemptStorePort["listPublishAttempts"]>;
  evidence: ReturnType<VerificationStorePort["listVerificationEvidence"]>;
  decisions: ReturnType<VerificationStorePort["listVerificationDecisions"]>;
  publication: ReturnType<VerificationStorePort["getVerifiedPublication"]>;
}

export class VerificationAdminReadModel {
  constructor(private readonly store: PublishAttemptStorePort & VerificationStorePort) {}

  intent(intentId: string): VerificationAdminView {
    return {
      intentId,
      attempts: this.store.listPublishAttempts(intentId),
      evidence: this.store.listVerificationEvidence(intentId),
      decisions: this.store.listVerificationDecisions(intentId),
      publication: this.store.getVerifiedPublication(intentId)
    };
  }
}
