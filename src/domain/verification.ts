import type {
  PublicationIntent,
  PublishAttempt,
  VerificationDecision,
  VerificationEvidence,
  VerificationOutcome,
  VerifiedPublication
} from "./model.js";

/** Backward-compatible positive verification policy used by the old orchestrator tests. */
export interface VerificationPolicy {
  name: string;
  evaluate(intent: PublicationIntent, evidence: readonly VerificationEvidence[]): VerifiedPublication | null;
}

export const profilePlusReceiptOrManual: VerificationPolicy = {
  name: "profile_plus_receipt_or_manual",
  evaluate(intent, evidence) {
    const positive = evidence.filter((e) => e.positive);
    const profile = positive.find((e) => e.kind === "profile_permalink" || e.kind === "profile_media_match");
    const supporting = positive.find((e) => e.kind === "ui_receipt" || e.kind === "manual_confirmation");
    if (!profile || !supporting) return null;
    return {
      publicationId: `publication:${intent.intentId}`,
      intentId: intent.intentId,
      verifiedAt: profile.observedAt,
      ...(profile.locator ? { permalink: profile.locator } : {}),
      evidenceIds: [profile.evidenceId, supporting.evidenceId]
    };
  }
};

export interface ReconciliationVerdict {
  outcome: VerificationOutcome;
  evidenceIds: readonly string[];
  reason: string;
  permalink?: string;
}

export interface ReconciliationPolicy {
  readonly name: string;
  evaluate(
    intent: PublicationIntent,
    attempt: PublishAttempt,
    evidence: readonly VerificationEvidence[],
    now: string
  ): ReconciliationVerdict;
}

export interface CompositeReconciliationPolicyOptions {
  negativeChecksRequired?: number;
  minimumNegativeSpanSeconds?: number;
  minimumAgeAfterBoundarySeconds?: number;
}

function millis(value: string): number {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) throw new Error(`Invalid timestamp: ${value}`);
  return time;
}

/**
 * Conservative policy:
 * - positive profile evidence + receipt/manual support => VERIFIED
 * - explicit human "not published" => SAFE_TO_RETRY unless positive evidence exists
 * - otherwise N negative profile checks spanning a minimum interval are required
 * - any positive publication signal prevents automatic retry
 */
export class CompositeReconciliationPolicy implements ReconciliationPolicy {
  readonly name = "composite_profile_receipt_and_conservative_negative_quorum";
  private readonly negativeChecksRequired: number;
  private readonly minimumNegativeSpanMs: number;
  private readonly minimumAgeAfterBoundaryMs: number;

  constructor(options: CompositeReconciliationPolicyOptions = {}) {
    this.negativeChecksRequired = options.negativeChecksRequired ?? 3;
    this.minimumNegativeSpanMs = (options.minimumNegativeSpanSeconds ?? 600) * 1000;
    this.minimumAgeAfterBoundaryMs = (options.minimumAgeAfterBoundarySeconds ?? 600) * 1000;
    if (this.negativeChecksRequired < 2) throw new Error("negativeChecksRequired must be >= 2");
    if (this.minimumNegativeSpanMs < 0 || this.minimumAgeAfterBoundaryMs < 0) throw new Error("negative verification timing cannot be negative");
  }

  evaluate(
    intent: PublicationIntent,
    attempt: PublishAttempt,
    evidence: readonly VerificationEvidence[],
    now: string
  ): ReconciliationVerdict {
    const relevant = evidence.filter((item) => item.intentId === intent.intentId && (!item.attemptId || item.attemptId === attempt.attemptId));
    const positive = relevant.filter((item) => item.positive);
    const profile = positive.find((item) => item.kind === "profile_permalink" || item.kind === "profile_media_match");
    const support = positive.find((item) => item.kind === "ui_receipt" || item.kind === "manual_confirmation");
    if (profile && support) {
      return {
        outcome: "VERIFIED",
        evidenceIds: [profile.evidenceId, support.evidenceId],
        reason: "positive profile evidence and independent publish support reached quorum",
        ...(profile.locator ? { permalink: profile.locator } : {})
      };
    }

    // Any positive publish signal makes an automatic retry unsafe, even if the
    // full positive quorum has not yet been reached.
    const publishSignal = positive.find((item) =>
      item.kind === "profile_permalink" ||
      item.kind === "profile_media_match" ||
      item.kind === "ui_receipt" ||
      item.kind === "manual_confirmation"
    );
    if (publishSignal) {
      return {
        outcome: "UNCERTAIN",
        evidenceIds: [publishSignal.evidenceId],
        reason: `positive publication signal ${publishSignal.kind} exists but verification quorum is incomplete`
      };
    }

    const manualNegative = relevant
      .filter((item) => !item.positive && item.kind === "manual_not_published")
      .sort((a, b) => millis(a.observedAt) - millis(b.observedAt))
      .at(-1);
    if (manualNegative) {
      return {
        outcome: "SAFE_TO_RETRY",
        evidenceIds: [manualNegative.evidenceId],
        reason: "authorized manual verification explicitly confirmed that the publication is absent"
      };
    }

    // Only a real absence observation counts here. `inconclusive_profile_check` is explicitly not
    // in this filter: "I read the surface and could not tell" must keep the intent UNCERTAIN
    // forever rather than accumulate towards a retry.
    const negatives = relevant
      .filter((item) => !item.positive && item.kind === "negative_profile_check")
      .sort((a, b) => millis(a.observedAt) - millis(b.observedAt));
    if (negatives.length < this.negativeChecksRequired) {
      return {
        outcome: "UNCERTAIN",
        evidenceIds: negatives.map((item) => item.evidenceId),
        reason: `negative evidence quorum incomplete: ${negatives.length}/${this.negativeChecksRequired}`
      };
    }

    const selected = negatives.slice(-this.negativeChecksRequired);
    const first = selected[0];
    const last = selected.at(-1);
    if (!first || !last) throw new Error("negative evidence selection unexpectedly empty");
    const span = millis(last.observedAt) - millis(first.observedAt);
    if (span < this.minimumNegativeSpanMs) {
      return {
        outcome: "UNCERTAIN",
        evidenceIds: selected.map((item) => item.evidenceId),
        reason: `negative evidence observations are too close together (${Math.round(span / 1000)}s)`
      };
    }

    const boundaryAt = attempt.irreversibleBoundaryEnteredAt ?? attempt.finalActionInvokedAt;
    if (!boundaryAt) {
      return {
        outcome: "UNCERTAIN",
        evidenceIds: selected.map((item) => item.evidenceId),
        reason: "attempt has no durable irreversible-boundary timestamp"
      };
    }
    const age = millis(last.observedAt) - millis(boundaryAt);
    if (age < this.minimumAgeAfterBoundaryMs) {
      return {
        outcome: "UNCERTAIN",
        evidenceIds: selected.map((item) => item.evidenceId),
        reason: `last negative observation is too early after the irreversible boundary (${Math.round(age / 1000)}s)`
      };
    }

    // 'now' is validated so accidental invalid clocks cannot silently pass.
    millis(now);
    return {
      outcome: "SAFE_TO_RETRY",
      evidenceIds: selected.map((item) => item.evidenceId),
      reason: `publication absent in ${selected.length} profile checks spanning ${Math.round(span / 1000)}s`
    };
  }
}

export function buildVerificationDecision(
  intent: PublicationIntent,
  attempt: PublishAttempt,
  verdict: ReconciliationVerdict,
  decidedAt: string,
  decisionId: string,
  policyName = "composite_profile_receipt_and_conservative_negative_quorum"
): VerificationDecision {
  return {
    decisionId,
    intentId: intent.intentId,
    attemptId: attempt.attemptId,
    decidedAt: new Date(decidedAt).toISOString(),
    outcome: verdict.outcome,
    policyName,
    evidenceIds: verdict.evidenceIds,
    reason: verdict.reason
  };
}
