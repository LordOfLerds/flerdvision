import type { Instant } from "../domain/model.js";
import type { Actor } from "../domain/control-plane.js";
import type { LeaseStorePort, PublicationIntentStorePort, ScheduleStorePort } from "../domain/control-plane-ports.js";
import type { PublishAttemptStorePort } from "../domain/verification-ports.js";
import { MissedWindowGuard } from "./scheduler.js";

export interface RecoveryReport {
  expiredLeasesReaped: number;
  safePrepareRollbacks: readonly string[];
  uncertainMarked: readonly string[];
  missedWindowsBlocked: readonly string[];
  skippedWithActiveLease: readonly string[];
}

type RecoveryStore = PublicationIntentStorePort & LeaseStorePort & ScheduleStorePort & Partial<Pick<PublishAttemptStorePort, "listPublishAttempts" | "markAttemptUncertain">>;

export class RestartRecoveryService {
  constructor(private readonly store: RecoveryStore) {}

  recover(now: Instant, actor: Actor = { type: "system", id: "restart-recovery" }): RecoveryReport {
    const expiredLeasesReaped = this.store.reapExpiredLeases(now, actor);
    const safePrepareRollbacks: string[] = [];
    const uncertainMarked: string[] = [];
    const skippedWithActiveLease: string[] = [];

    for (const record of this.store.listIntents(["PREPARING", "PUBLISHING", "VERIFYING"])) {
      const resourceKey = `publication-intent:${record.intent.intentId}`;
      const lease = this.store.getLease(resourceKey);
      if (lease && lease.expiresAt > new Date(now).toISOString()) {
        skippedWithActiveLease.push(record.intent.intentId);
        continue;
      }

      if (record.state === "PREPARING") {
        this.store.transitionIntent(
          record.intent.intentId,
          "SCHEDULED",
          now,
          actor,
          "restart_before_final_action_safe_rollback"
        );
        safePrepareRollbacks.push(record.intent.intentId);
      } else {
        const attempts = this.store.listPublishAttempts?.(record.intent.intentId) ?? [];
        const latest = attempts.at(-1);
        if (latest && latest.irreversibleBoundaryEnteredAt && this.store.markAttemptUncertain) {
          this.store.markAttemptUncertain(
            latest.attemptId,
            now,
            actor,
            "restart_after_irreversible_boundary_requires_reconciliation"
          );
        } else {
          this.store.transitionIntent(
            record.intent.intentId,
            "PUBLISH_UNCERTAIN",
            now,
            actor,
            "restart_after_irreversible_boundary_requires_reconciliation"
          );
        }
        uncertainMarked.push(record.intent.intentId);
      }
    }

    const missedWindowsBlocked = new MissedWindowGuard(this.store).blockMissed(now, actor);
    return {
      expiredLeasesReaped,
      safePrepareRollbacks,
      uncertainMarked,
      missedWindowsBlocked,
      skippedWithActiveLease
    };
  }
}
