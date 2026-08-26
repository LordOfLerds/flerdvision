import type { PublicationIntent, PublishAttempt, VerifiedPublication } from "../domain/model.js";
import type { PublicationVerifierPort, PublisherPort, PublishContext } from "../domain/ports.js";
import { assertFinalPublishAllowed } from "../domain/safety.js";

export type ExecutionOutcome =
  | { kind: "prepared_only"; attempt: PublishAttempt }
  | { kind: "verified"; attempt: PublishAttempt; publication: VerifiedPublication }
  | { kind: "uncertain"; attempt: PublishAttempt };

export class PublishOrchestrator {
  constructor(
    private readonly publisher: PublisherPort,
    private readonly verifier: PublicationVerifierPort
  ) {}

  async execute(intent: PublicationIntent, context: PublishContext): Promise<ExecutionOutcome> {
    const prepared = await this.publisher.prepare(intent);
    if (context.mode === "disabled" || context.mode === "prepare_only") {
      return { kind: "prepared_only", attempt: prepared };
    }

    assertFinalPublishAllowed(intent, context);
    const attempted = await this.publisher.invokeFinalAction(intent, prepared, context);
    const evidence = await this.verifier.collectEvidence(intent, attempted);
    const publication = await this.verifier.decide(intent, evidence);
    if (publication) return { kind: "verified", attempt: attempted, publication };
    return { kind: "uncertain", attempt: { ...attempted, result: "uncertain" } };
  }
}
