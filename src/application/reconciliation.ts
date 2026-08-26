import type { Actor } from "../domain/control-plane.js";
import type { PublicationIntentStorePort } from "../domain/control-plane-ports.js";
import type { VerificationDecision, VerifiedPublication } from "../domain/model.js";
import type { PublishAttemptStorePort, VerificationEvidenceCollectorPort, VerificationStorePort } from "../domain/verification-ports.js";
import type { ReconciliationPolicy } from "../domain/verification.js";
import { buildVerificationDecision } from "../domain/verification.js";

export class ReconciliationError extends Error {}

export interface ReconciliationResult {
  decision: VerificationDecision;
  publication?: VerifiedPublication;
  collectorErrors: readonly { collector: string; error: string }[];
}

type ReconciliationStore = PublicationIntentStorePort & PublishAttemptStorePort & VerificationStorePort;

function decisionId(intentId: string, attemptId: string, now: string): string {
  return `decision:${intentId}:${attemptId}:${new Date(now).getTime().toString(36)}:${Math.random().toString(36).slice(2, 9)}`;
}

export class ReconciliationService {
  constructor(
    private readonly store: ReconciliationStore,
    private readonly collectors: readonly VerificationEvidenceCollectorPort[],
    private readonly policy: ReconciliationPolicy,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  async reconcile(intentId: string, attemptId: string, actor: Actor): Promise<ReconciliationResult> {
    const intentRecord = this.store.getIntent(intentId);
    if (!intentRecord) throw new ReconciliationError(`Unknown publication intent: ${intentId}`);
    const attempt = this.store.getPublishAttempt(attemptId);
    if (!attempt || attempt.intentId !== intentId) throw new ReconciliationError(`Unknown/mismatched publish attempt: ${attemptId}`);

    const existingPublication = this.store.getVerifiedPublication(intentId);
    if (existingPublication) {
      const timestamp = this.now();
      let state = intentRecord.state;
      if (state === "PUBLISH_UNCERTAIN") {
        this.store.transitionIntent(intentId, "VERIFYING", timestamp, actor, "existing_verified_publication_reconciliation");
        state = "VERIFYING";
      }
      if (state === "VERIFYING") {
        this.store.transitionIntent(intentId, "VERIFIED", timestamp, actor, "existing_verified_publication_recovered_after_interrupted_commit_sequence");
      } else if (state !== "VERIFIED") {
        throw new ReconciliationError(`Verified publication exists while intent is in incompatible state ${state}`);
      }
      const decision = this.store.recordVerificationDecision(buildVerificationDecision(
        intentRecord.intent,
        attempt,
        {
          outcome: "VERIFIED",
          evidenceIds: existingPublication.evidenceIds,
          reason: "intent already has an immutable verified publication",
          ...(existingPublication.permalink ? { permalink: existingPublication.permalink } : {})
        },
        timestamp,
        decisionId(intentId, attemptId, timestamp),
        this.policy.name
      ), actor);
      return { decision, publication: existingPublication, collectorErrors: [] };
    }

    let state = intentRecord.state;
    if (state === "PUBLISH_UNCERTAIN") {
      this.store.transitionIntent(intentId, "VERIFYING", this.now(), actor, "reconciliation_started");
      state = "VERIFYING";
    }
    if (state !== "VERIFYING") throw new ReconciliationError(`Intent ${intentId} must be VERIFYING or PUBLISH_UNCERTAIN, got ${state}`);

    const collectorErrors: Array<{ collector: string; error: string }> = [];
    for (const collector of this.collectors) {
      try {
        const evidence = await collector.collect(intentRecord.intent, attempt);
        for (const item of evidence) {
          if (item.intentId !== intentId) throw new ReconciliationError(`Collector ${collector.name} returned evidence for another intent`);
          if (item.attemptId && item.attemptId !== attemptId) throw new ReconciliationError(`Collector ${collector.name} returned evidence for another attempt`);
          this.store.recordVerificationEvidence({ ...item, attemptId }, actor);
        }
      } catch (error) {
        collectorErrors.push({ collector: collector.name, error: error instanceof Error ? error.message : String(error) });
      }
    }

    const timestamp = this.now();
    const allEvidence = this.store.listVerificationEvidence(intentId, attemptId);
    const verdict = this.policy.evaluate(intentRecord.intent, this.store.getPublishAttempt(attemptId) ?? attempt, allEvidence, timestamp);
    const decision = this.store.recordVerificationDecision(
      buildVerificationDecision(intentRecord.intent, attempt, verdict, timestamp, decisionId(intentId, attemptId, timestamp), this.policy.name),
      actor
    );

    if (verdict.outcome === "VERIFIED") {
      const publication: VerifiedPublication = {
        publicationId: `publication:${intentId}`,
        intentId,
        verifiedAt: timestamp,
        evidenceIds: verdict.evidenceIds,
        ...(verdict.permalink ? { permalink: verdict.permalink } : {})
      };
      const storedPublication = this.store.recordVerifiedPublication(publication, actor);
      this.store.transitionIntent(intentId, "VERIFIED", timestamp, actor, "verification_quorum_reached");
      return { decision, publication: storedPublication, collectorErrors };
    }

    if (verdict.outcome === "SAFE_TO_RETRY") {
      this.store.transitionIntent(intentId, "RETRY_WAIT", timestamp, actor, "reconciliation_proved_publication_absent");
      return { decision, collectorErrors };
    }

    this.store.transitionIntent(intentId, "PUBLISH_UNCERTAIN", timestamp, actor, "verification_remains_uncertain");
    return { decision, collectorErrors };
  }
}
