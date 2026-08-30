import type { Instant, PublicationIntent } from "../domain/model.js";
import type { Actor, ScheduleReservation, StoredPublicationIntent } from "../domain/control-plane.js";
import type { PublicationIntentStorePort, ScheduleStorePort } from "../domain/control-plane-ports.js";
import type { OperationalPublishGatePort } from "../domain/operations-ports.js";
import {
  buildReservation,
  businessDateForInstant,
  DEFAULT_SCHEDULING_POLICY,
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
    private readonly store: PublicationIntentStorePort & ScheduleStorePort & {
      acquireLease: import("../domain/control-plane-ports.js").LeaseStorePort["acquireLease"];
      releaseLease: import("../domain/control-plane-ports.js").LeaseStorePort["releaseLease"];
    },
    private readonly operationalGate?: OperationalPublishGatePort
  ) {}

  claimNext(ownerId: string, now: Instant, ttlSeconds: number, eligible?: (intent: PublicationIntent) => boolean): ClaimedWork | null {
    const workerActor: Actor = { type: "worker", id: ownerId };
    for (const reservation of this.store.listDueReservations(now)) {
      const candidate = this.store.getIntent(reservation.intentId);
      if (!candidate) continue;
      // A worker must never claim what it may not execute: claiming first and failing the
      // account allowlist after the browser prepare burned foreign due intents to BLOCKED.
      // Ineligible work stays SCHEDULED for the worker that owns it.
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
          "due_work_claimed"
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
  constructor(private readonly store: PublicationIntentStorePort & ScheduleStorePort) {}

  blockMissed(now: Instant, actor: Actor = { type: "system", id: "missed-window-guard" }): readonly string[] {
    const blocked: string[] = [];
    for (const reservation of this.store.listMissedReservations(now)) {
      this.store.transitionIntent(
        reservation.intentId,
        "BLOCKED",
        now,
        actor,
        `schedule_window_missed:${reservation.windowEndAt}`
      );
      blocked.push(reservation.intentId);
    }
    return blocked;
  }
}
