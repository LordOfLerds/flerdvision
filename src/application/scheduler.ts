import type { Instant, PublicationIntent } from "../domain/model.js";
import { jitterSeconds } from "../adapters/browser/human-pacing.js";
import type { Actor, ScheduleReservation, StoredPublicationIntent } from "../domain/control-plane.js";
import type { PublicationIntentStorePort, ScheduleStorePort } from "../domain/control-plane-ports.js";
import type { OperationalPublishGatePort } from "../domain/operations-ports.js";
import type { PublishAttemptStorePort } from "../domain/verification-ports.js";
import {
  buildReservation,
  businessDateForInstant,
  DEFAULT_SCHEDULING_POLICY,
  isWithinCatchUp,
  MISSED_WINDOW_WAIVE_REASON,
  type SchedulingPolicy
} from "../domain/scheduling.js";

export class PublicationScheduler {
  constructor(
    private readonly store: PublicationIntentStorePort & ScheduleStorePort,
    private readonly policy: SchedulingPolicy = DEFAULT_SCHEDULING_POLICY
  ) {}

  scheduleIntent(intentId: string, now: Instant, actor: Actor): ScheduleReservation {
    const record = this.store.getIntent(intentId);
    if (!record) throw new Error(`Publication intent not found: ${intentId}`);
    if (record.state !== "READY") throw new Error(`Intent ${intentId} must be READY to schedule; got ${record.state}`);

    const businessDate = businessDateForInstant(record.intent.scheduledFor, this.policy.timeZone);
    const existing = this.store.listReservations(record.intent.accountId, businessDate);
    const reservation = buildReservation(record.intent, this.policy, existing, now);
    return this.store.reserveIntent(intentId, reservation, now, actor);
  }

  scheduleAllReady(now: Instant, actor: Actor): readonly ScheduleReservation[] {
    const ready = [...this.store.listIntents(["READY"])].sort(
      (a, b) => a.intent.scheduledFor.localeCompare(b.intent.scheduledFor) || a.intent.intentId.localeCompare(b.intent.intentId)
    );
    const scheduled: ScheduleReservation[] = [];
    for (const record of ready) scheduled.push(this.scheduleIntent(record.intent.intentId, now, actor));
    return scheduled;
  }
}

export interface ClaimedWork {
  record: StoredPublicationIntent;
  reservation: ScheduleReservation;
  leaseResourceKey: string;
  leaseOwnerId: string;
}

export class DueWorkClaimer {
  constructor(
    private readonly store: PublicationIntentStorePort & ScheduleStorePort & Pick<PublishAttemptStorePort, "listPublishAttempts"> & {
      acquireLease: import("../domain/control-plane-ports.js").LeaseStorePort["acquireLease"];
      releaseLease: import("../domain/control-plane-ports.js").LeaseStorePort["releaseLease"];
    },
    private readonly operationalGate?: OperationalPublishGatePort,
    private readonly policy: SchedulingPolicy = DEFAULT_SCHEDULING_POLICY
  ) {}

  claimNext(ownerId: string, now: Instant, ttlSeconds: number, eligible?: (intent: PublicationIntent) => boolean, jitterMaxSeconds = 0): ClaimedWork | null {
    const workerActor: Actor = { type: "worker", id: ownerId };
    const nowMs = new Date(now).getTime();

    // Outage catch-up (operator decision, binding): a reservation whose on-time window already
    // closed stays claimable until scheduledFor + catchUpHours, but ONLY when the intent was
    // NEVER attempted. listPublishAttempts is the source of truth -- a "prepared" attempt row is
    // written before the final-action click, so its mere existence already rules out a second
    // click. Once catch-up also elapses, MissedWindowGuard waives the intent instead.
    const catchUpReservations = this.store.listMissedReservations(now).filter(
      (reservation) =>
        isWithinCatchUp(reservation.targetAt, this.policy, now) &&
        this.store.listPublishAttempts(reservation.intentId).length === 0
    );
    const catchUpReservationIds = new Set(catchUpReservations.map((reservation) => reservation.reservationId));
    // Earliest overdue first: on-time and catch-up candidates are merged and claimed in target
    // order, so an outage never lets a later slot jump ahead of an earlier one for the same or a
    // different account.
    const candidates = [...this.store.listDueReservations(now), ...catchUpReservations].sort(
      (a, b) => a.targetAt.localeCompare(b.targetAt) || a.reservationId.localeCompare(b.reservationId)
    );

    for (const reservation of candidates) {
      // Human launch scatter (operator decision): dueness begins at windowStart, which posted
      // machine-punctually up to 30 minutes early. The launch instant is target plus a
      // deterministic per-intent offset, clamped two minutes before the window closes so the
      // scatter can never turn into a missed window. A catch-up reservation's window has already
      // closed, so its clamped launch instant is always in the past and jitter never delays it.
      if (jitterMaxSeconds > 0) {
        const offset = jitterSeconds(reservation.intentId, jitterMaxSeconds) * 1000;
        const launchMs = Math.min(new Date(reservation.targetAt).getTime() + offset, new Date(reservation.windowEndAt).getTime() - 120_000);
        if (nowMs < launchMs) continue;
      }
      const candidate = this.store.getIntent(reservation.intentId);
      if (!candidate) continue;
      // A worker must never claim what it may not execute: claiming first and failing the
      // account allowlist after the browser prepare burned foreign due intents to BLOCKED.
      // Ineligible work stays SCHEDULED for the worker that owns it. Kill switches, pauses and
      // account allowlists gate catch-up exactly like an on-time claim.
      if (eligible && !eligible(candidate.intent)) continue;
      if (this.operationalGate && !this.operationalGate.evaluate(candidate.intent).allowed) continue;
      const resourceKey = `publication-intent:${reservation.intentId}`;
      const lease = this.store.acquireLease(resourceKey, ownerId, now, ttlSeconds, workerActor);
      if (!lease) continue;
      try {
        const record = this.store.transitionIntent(
          reservation.intentId,
          "PREPARING",
          now,
          workerActor,
          catchUpReservationIds.has(reservation.reservationId) ? "due_work_claimed:catch_up" : "due_work_claimed"
        );
        return {
          record,
          reservation,
          leaseResourceKey: resourceKey,
          leaseOwnerId: ownerId
        };
      } catch (error) {
        this.store.releaseLease(resourceKey, ownerId, now, workerActor);
        throw error;
      }
    }
    return null;
  }
}

export class MissedWindowGuard {
  constructor(
    private readonly store: PublicationIntentStorePort & ScheduleStorePort,
    private readonly policy: SchedulingPolicy = DEFAULT_SCHEDULING_POLICY
  ) {}

  /**
   * Waives a SCHEDULED intent once its outage catch-up grace period (scheduledFor +
   * catchUpHours, see DueWorkClaimer.claimNext) has also elapsed without a claim. A reservation
   * still inside that grace period is left untouched -- it remains a live catch-up candidate.
   * WAIVED (not BLOCKED): there is nothing left to recover once catch-up itself has expired.
   */
  waiveMissed(now: Instant, actor: Actor = { type: "system", id: "missed-window-guard" }): readonly string[] {
    const waived: string[] = [];
    for (const reservation of this.store.listMissedReservations(now)) {
      if (isWithinCatchUp(reservation.targetAt, this.policy, now)) continue;
      this.store.transitionIntent(
        reservation.intentId,
        "WAIVED",
        now,
        actor,
        MISSED_WINDOW_WAIVE_REASON
      );
      waived.push(reservation.intentId);
    }
    return waived;
  }
}
