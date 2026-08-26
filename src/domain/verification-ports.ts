import type { Actor } from "./control-plane.js";
import type { BrowserIdentity } from "./browser-identity.js";
import type { BrowserPageSessionPort } from "./browser-identity-ports.js";
import type {
  Instant,
  PublicationIntent,
  PublishAttempt,
  VerificationDecision,
  VerificationEvidence,
  VerifiedPublication
} from "./model.js";

export interface PublishAttemptStorePort {
  recordPreparedAttempt(attempt: PublishAttempt, actor: Actor): PublishAttempt;
  getPublishAttempt(attemptId: string): PublishAttempt | null;
  listPublishAttempts(intentId?: string): readonly PublishAttempt[];
  enterIrreversibleBoundary(attemptId: string, at: Instant, actor: Actor): PublishAttempt;
  markFinalActionInvoked(attemptId: string, at: Instant, actor: Actor): PublishAttempt;
  markAttemptUncertain(attemptId: string, at: Instant, actor: Actor, reason: string): PublishAttempt;
  markAttemptFailed(attemptId: string, at: Instant, actor: Actor, reason: string): PublishAttempt;
}

export interface VerificationStorePort {
  recordVerificationEvidence(evidence: VerificationEvidence, actor: Actor): VerificationEvidence;
  listVerificationEvidence(intentId: string, attemptId?: string): readonly VerificationEvidence[];
  recordVerificationDecision(decision: VerificationDecision, actor: Actor): VerificationDecision;
  listVerificationDecisions(intentId: string): readonly VerificationDecision[];
  recordVerifiedPublication(publication: VerifiedPublication, actor: Actor): VerifiedPublication;
  getVerifiedPublication(intentId: string): VerifiedPublication | null;
  listVerifiedPublications(): readonly VerifiedPublication[];
}

export interface VerificationEvidenceCollectorPort {
  readonly name: string;
  collect(intent: PublicationIntent, attempt: PublishAttempt): Promise<readonly VerificationEvidence[]>;
}

export interface FinalActionInvocationResult {
  invokedAt: Instant;
  finishedAt: Instant;
  evidence?: readonly VerificationEvidence[];
}

/**
 * The caller MUST persist entry into the irreversible boundary before invoking
 * this port. Implementations must never hide or bypass that ordering.
 */
export interface FinalActionInvokerPort {
  invoke(intent: PublicationIntent, attempt: PublishAttempt): Promise<FinalActionInvocationResult>;
}

export interface VerificationArtifactSinkPort {
  capture(
    session: BrowserPageSessionPort,
    intent: PublicationIntent,
    identity: BrowserIdentity,
    attempt: PublishAttempt,
    label: string,
    now: Instant
  ): Promise<readonly string[]>;
  writeManualEvidence(intent: PublicationIntent, attempt: PublishAttempt, payload: Readonly<Record<string, unknown>>, now: Instant): Promise<string>;
}
