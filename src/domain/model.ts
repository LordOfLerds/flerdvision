export type UUID = string;
export type Instant = string;

export type Platform = "instagram" | "tiktok" | "youtube";
export type PublicationFormat =
  | "reel"
  | "trial_reel"
  | "tiktok"
  | "short"
  | "story"
  | "unknown";

export interface SourceObservation {
  observationId: UUID;
  sourceId: string;
  externalObjectId: string;
  observedAt: Instant;
  locator: string;
  mediaFingerprint?: string;
  metadata: Readonly<Record<string, string>>;
}

export interface ContentItem {
  contentId: UUID;
  acceptedFromObservationId: UUID;
  creatorId: string;
  mediaFingerprint: string;
  immutableMediaRef: string;
  scheduledBusinessDate?: string;
  metadata: Readonly<Record<string, string>>;
}

export interface PublicationIntent {
  intentId: UUID;
  contentId: UUID;
  creatorId: string;
  platform: Platform;
  accountId: string;
  format: PublicationFormat;
  copyVersionId: string;
  scheduledFor: Instant;
  idempotencyKey: string;
}

export type PublishAttemptResult =
  | "not_started"
  | "prepared"
  | "boundary_entered"
  | "final_action_invoked"
  | "failed"
  | "uncertain";

export interface PublishAttempt {
  attemptId: UUID;
  intentId: UUID;
  browserIdentityId: string;
  releaseSha: string;
  startedAt: Instant;
  /**
   * Persisted BEFORE the UI action that may publish content. If the process dies
   * after this timestamp, the outcome must be reconciled before any retry.
   */
  irreversibleBoundaryEnteredAt?: Instant;
  /** Recorded only after the final UI action returns control to the worker. */
  finalActionInvokedAt?: Instant;
  finishedAt?: Instant;
  result: PublishAttemptResult;
  mediaSha256?: string;
  preparationArtifactRefs?: readonly string[];
  reachedFinalActionBoundary?: boolean;
}

export type EvidenceKind =
  | "ui_receipt"
  | "profile_permalink"
  | "profile_media_match"
  | "manual_confirmation"
  | "manual_not_published"
  | "negative_profile_check"
  /**
   * The surface was reachable and was read, but what it showed proves neither publication nor
   * absence: several posts in the window carry the same copy, the caption could not be read at
   * all, or the post timestamps are too coarse to place a post inside the window. It is
   * deliberately NOT `negative_profile_check`: a non-observation must never feed the
   * conservative retry quorum.
   */
  | "inconclusive_profile_check";

export interface VerificationEvidence {
  evidenceId: UUID;
  intentId: UUID;
  attemptId?: UUID;
  kind: EvidenceKind;
  observedAt: Instant;
  positive: boolean;
  locator?: string;
  artifactRef?: string;
  note?: string;
}

export type VerificationOutcome = "VERIFIED" | "SAFE_TO_RETRY" | "UNCERTAIN";

export interface VerificationDecision {
  decisionId: UUID;
  intentId: UUID;
  attemptId?: UUID;
  decidedAt: Instant;
  outcome: VerificationOutcome;
  policyName: string;
  evidenceIds: readonly UUID[];
  reason: string;
}

export interface VerifiedPublication {
  publicationId: UUID;
  intentId: UUID;
  verifiedAt: Instant;
  permalink?: string;
  evidenceIds: readonly UUID[];
}
