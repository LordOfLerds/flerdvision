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

export interface PublishAttempt {
  attemptId: UUID;
  intentId: UUID;
  browserIdentityId: string;
  releaseSha: string;
  startedAt: Instant;
  finalActionInvokedAt?: Instant;
  finishedAt?: Instant;
  result: "not_started" | "prepared" | "final_action_invoked" | "failed" | "uncertain";
}

export type EvidenceKind =
  | "ui_receipt"
  | "profile_permalink"
  | "profile_media_match"
  | "manual_confirmation"
  | "negative_profile_check";

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

export interface VerifiedPublication {
  publicationId: UUID;
  intentId: UUID;
  verifiedAt: Instant;
  permalink?: string;
  evidenceIds: readonly UUID[];
}
