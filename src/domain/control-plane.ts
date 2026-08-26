import type { PublicationIntent, Instant, UUID } from "./model.js";
import type { PublicationState } from "./states.js";

export type ActorType = "system" | "worker" | "operator" | "test" | "migration";

export interface Actor {
  type: ActorType;
  id: string;
}

export interface StoredPublicationIntent {
  intent: PublicationIntent;
  state: PublicationState;
  createdAt: Instant;
  updatedAt: Instant;
}

export interface ScheduleReservation {
  reservationId: UUID;
  intentId: UUID;
  accountId: string;
  platform: PublicationIntent["platform"];
  businessDate: string;
  slotKey: string;
  targetAt: Instant;
  windowStartAt: Instant;
  windowEndAt: Instant;
  createdAt: Instant;
}

export interface WorkerLease {
  resourceKey: string;
  ownerId: string;
  acquiredAt: Instant;
  heartbeatAt: Instant;
  expiresAt: Instant;
}

export interface AuditEvent {
  sequence: number;
  eventId: UUID;
  aggregateType: "publication_intent" | "schedule_reservation" | "worker_lease" | "source_observation" | "content_item" | "source_disposition" | "social_account" | "browser_identity" | "session_health" | "platform_capability" | "system";
  aggregateId: string;
  eventType: string;
  occurredAt: Instant;
  actor: Actor;
  fromState?: PublicationState;
  toState?: PublicationState;
  payload: Readonly<Record<string, unknown>>;
}

export type CreateIntentResult =
  | { created: true; record: StoredPublicationIntent }
  | { created: false; record: StoredPublicationIntent };

export interface ControlPlaneSummary {
  generatedAt: Instant;
  states: Readonly<Record<PublicationState, number>>;
  activeLeases: number;
  scheduledOpen: number;
  dueNow: number;
  missedWindows: number;
}
