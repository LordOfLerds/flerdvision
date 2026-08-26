import type {
  PublicationIntent,
  PublishAttempt,
  SourceObservation,
  VerificationEvidence,
  VerifiedPublication
} from "./model.js";

export interface ContentIngressPort {
  observe(): Promise<readonly SourceObservation[]>;
}

export interface IngressInterpretation {
  observationId: string;
  decision: "accept" | "ignore" | "block";
  creatorId?: string;
  scheduledBusinessDate?: string;
  formatHints?: readonly string[];
  reason?: string;
}

export interface IngressInterpreterPort {
  interpret(observation: SourceObservation): Promise<IngressInterpretation>;
}

export interface SourceDispositionPort {
  markCompleted(sourceObservationId: string, publicationIds: readonly string[]): Promise<void>;
  markBlocked(sourceObservationId: string, reason: string): Promise<void>;
}

export interface PublishContext {
  mode: "disabled" | "prepare_only" | "test_account" | "canary" | "production";
  allowFinalPublish: boolean;
  allowedAccountIds: ReadonlySet<string>;
  releaseSha: string;
}

export interface PublisherPort {
  prepare(intent: PublicationIntent): Promise<PublishAttempt>;
  invokeFinalAction(intent: PublicationIntent, preparedAttempt: PublishAttempt, context: PublishContext): Promise<PublishAttempt>;
}

export interface PublicationVerifierPort {
  collectEvidence(intent: PublicationIntent, attempt?: PublishAttempt): Promise<readonly VerificationEvidence[]>;
  decide(intent: PublicationIntent, evidence: readonly VerificationEvidence[]): Promise<VerifiedPublication | null>;
}

export interface NotificationPort {
  readiness(summary: string): Promise<void>;
  incident(title: string, body: string, artifactRefs?: readonly string[]): Promise<void>;
  completion(summary: string): Promise<void>;
}
