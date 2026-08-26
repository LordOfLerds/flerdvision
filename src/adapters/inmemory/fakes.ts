import type {
  PublicationIntent,
  PublishAttempt,
  VerificationEvidence,
  VerifiedPublication
} from "../../domain/model.js";
import type {
  PublicationVerifierPort,
  PublisherPort,
  PublishContext
} from "../../domain/ports.js";
import { profilePlusReceiptOrManual } from "../../domain/verification.js";

export class FakePublisher implements PublisherPort {
  finalInvocations = 0;

  async prepare(intent: PublicationIntent): Promise<PublishAttempt> {
    return {
      attemptId: `attempt:${intent.intentId}:1`,
      intentId: intent.intentId,
      browserIdentityId: `browser:${intent.accountId}`,
      releaseSha: "test",
      startedAt: "2026-08-26T08:59:00+02:00",
      result: "prepared"
    };
  }

  async invokeFinalAction(
    _intent: PublicationIntent,
    preparedAttempt: PublishAttempt,
    _context: PublishContext
  ): Promise<PublishAttempt> {
    this.finalInvocations += 1;
    return {
      ...preparedAttempt,
      finalActionInvokedAt: "2026-08-26T09:00:00+02:00",
      finishedAt: "2026-08-26T09:00:02+02:00",
      result: "final_action_invoked"
    };
  }
}

export class FakeVerifier implements PublicationVerifierPort {
  constructor(private readonly mode: "verified" | "uncertain") {}

  async collectEvidence(intent: PublicationIntent, attempt?: PublishAttempt): Promise<readonly VerificationEvidence[]> {
    if (this.mode === "uncertain") return [];
    return [
      {
        evidenceId: `e:profile:${intent.intentId}`,
        intentId: intent.intentId,
        ...(attempt ? { attemptId: attempt.attemptId } : {}),
        kind: "profile_permalink",
        observedAt: "2026-08-26T09:01:00+02:00",
        positive: true,
        locator: `https://example.invalid/post/${intent.intentId}`
      },
      {
        evidenceId: `e:receipt:${intent.intentId}`,
        intentId: intent.intentId,
        ...(attempt ? { attemptId: attempt.attemptId } : {}),
        kind: "ui_receipt",
        observedAt: "2026-08-26T09:00:03+02:00",
        positive: true
      }
    ];
  }

  async decide(intent: PublicationIntent, evidence: readonly VerificationEvidence[]): Promise<VerifiedPublication | null> {
    return profilePlusReceiptOrManual.evaluate(intent, evidence);
  }
}
