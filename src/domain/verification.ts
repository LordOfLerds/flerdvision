import type { PublicationIntent, VerificationEvidence, VerifiedPublication } from "./model.js";

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
