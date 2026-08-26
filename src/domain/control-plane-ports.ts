import type { Instant, PublicationIntent } from "./model.js";
import type { PublicationState } from "./states.js";
import type {
  Actor,
  AuditEvent,
  ControlPlaneSummary,
  CreateIntentResult,
  ScheduleReservation,
  StoredPublicationIntent,
  WorkerLease
} from "./control-plane.js";

export interface PublicationIntentStorePort {
  createOrGetIntent(intent: PublicationIntent, now: Instant, actor: Actor): CreateIntentResult;
  getIntent(intentId: string): StoredPublicationIntent | null;
  listIntents(states?: readonly PublicationState[]): readonly StoredPublicationIntent[];
  transitionIntent(intentId: string, to: PublicationState, now: Instant, actor: Actor, reason?: string): StoredPublicationIntent;
}

export interface EventLogPort {
  listEvents(aggregateType?: AuditEvent["aggregateType"], aggregateId?: string): readonly AuditEvent[];
}

export interface ScheduleStorePort {
  reserveIntent(
    intentId: string,
    reservation: ScheduleReservation,
    now: Instant,
    actor: Actor
  ): ScheduleReservation;
  getReservationForIntent(intentId: string): ScheduleReservation | null;
  listReservations(accountId?: string, businessDate?: string): readonly ScheduleReservation[];
  listDueReservations(now: Instant): readonly ScheduleReservation[];
  listMissedReservations(now: Instant): readonly ScheduleReservation[];
}

export interface LeaseStorePort {
  acquireLease(resourceKey: string, ownerId: string, now: Instant, ttlSeconds: number, actor: Actor): WorkerLease | null;
  heartbeatLease(resourceKey: string, ownerId: string, now: Instant, ttlSeconds: number, actor: Actor): WorkerLease | null;
  releaseLease(resourceKey: string, ownerId: string, now: Instant, actor: Actor): boolean;
  getLease(resourceKey: string): WorkerLease | null;
  listActiveLeases(now: Instant): readonly WorkerLease[];
  reapExpiredLeases(now: Instant, actor: Actor): number;
}

export interface ControlPlaneReadPort {
  summary(now: Instant): ControlPlaneSummary;
}

export type ControlPlaneStorePort = PublicationIntentStorePort &
  EventLogPort &
  ScheduleStorePort &
  LeaseStorePort &
  ControlPlaneReadPort;
