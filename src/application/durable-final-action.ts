import type { Actor } from "../domain/control-plane.js";
import type { PublicationIntentStorePort } from "../domain/control-plane-ports.js";
import type { PublishContext } from "../domain/ports.js";
import { assertFinalPublishAllowed } from "../domain/safety.js";
import type { VerificationEvidence } from "../domain/model.js";
import type { OperationalPublishGatePort } from "../domain/operations-ports.js";
import type {
  FinalActionInvokerPort,
  PublishAttemptStorePort,
  VerificationStorePort
} from "../domain/verification-ports.js";

export class FinalActionLifecycleError extends Error {}

export type DurableFinalActionOutcome =
  | { kind: "invoked"; attemptId: string; evidence: readonly VerificationEvidence[] }
  | { kind: "uncertain"; attemptId: string; error: string };

type FinalActionStore = PublicationIntentStorePort & PublishAttemptStorePort & VerificationStorePort;

/**
 * Owns the irreversible ordering guarantee:
 *   durable boundary record -> UI action -> receipt persistence.
 * The invoker never receives control before the durable boundary is stored.
 */
export class DurableFinalActionService {
  constructor(
    private readonly store: FinalActionStore,
    private readonly invoker: FinalActionInvokerPort,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly operationalGate?: OperationalPublishGatePort
  ) {}

  async execute(
    intentId: string,
    attemptId: string,
    context: PublishContext,
    actor: Actor
  ): Promise<DurableFinalActionOutcome> {
    const record = this.store.getIntent(intentId);
    if (!record) throw new FinalActionLifecycleError(`Unknown publication intent: ${intentId}`);
    const attempt = this.store.getPublishAttempt(attemptId);
    if (!attempt) throw new FinalActionLifecycleError(`Unknown publish attempt: ${attemptId}`);
    if (attempt.intentId !== intentId) throw new FinalActionLifecycleError("Publish attempt does not belong to intent");
    if (attempt.result !== "prepared") throw new FinalActionLifecycleError(`Attempt ${attemptId} is not prepared: ${attempt.result}`);
    if (record.state !== "PREPARING") throw new FinalActionLifecycleError(`Intent ${intentId} must be PREPARING, got ${record.state}`);

    assertFinalPublishAllowed(record.intent, context);
    this.operationalGate?.assertAllowed(record.intent);

    // This write occurs BEFORE the actual UI action. A hard crash after this
    // line is deliberately treated as potentially published.
    const boundaryAttempt = this.store.enterIrreversibleBoundary(attemptId, this.now(), actor);

    try {
      const result = await this.invoker.invoke(record.intent, boundaryAttempt);
      for (const item of result.evidence ?? []) {
        if (item.intentId !== intentId) throw new FinalActionLifecycleError("Final-action evidence intent mismatch");
        if (item.attemptId && item.attemptId !== attemptId) throw new FinalActionLifecycleError("Final-action evidence attempt mismatch");
        this.store.recordVerificationEvidence({ ...item, attemptId }, actor);
      }
      this.store.markFinalActionInvoked(attemptId, result.invokedAt, actor);
      return { kind: "invoked", attemptId, evidence: result.evidence ?? [] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.markAttemptUncertain(attemptId, this.now(), actor, `final_action_exception:${message}`);
      return { kind: "uncertain", attemptId, error: message };
    }
  }
}
