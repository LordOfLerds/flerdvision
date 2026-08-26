import type { Instant, Platform, UUID } from "./model.js";

export type E2ERunStatus = "PLANNED" | "ACTIVE" | "BLOCKED" | "PASSED" | "ABORTED";

export type E2EGateKind =
  | "HOST_PREFLIGHT"
  | "SESSION_HEALTH"
  | "IDENTITY_GUARD"
  | "UI_CALIBRATION"
  | "PREPARE_ONLY_REPLAY"
  | "PRIVACY_ATTESTATION"
  | "FINAL_ACTION_CALIBRATION"
  | "PRIVATE_PUBLISH"
  | "VERIFICATION"
  | "CLEANUP"
  | "FAILURE_INJECTION";

export type E2EGateStatus = "PASS" | "FAIL" | "PENDING" | "NOT_APPLICABLE";

export interface PrivateE2ERun {
  runId: UUID;
  accountId: string;
  platform: Platform;
  releaseSha: string;
  createdAt: Instant;
  createdBy: string;
  status: E2ERunStatus;
  testMediaOnly: true;
  zeroViewerRequired: boolean;
  note?: string;
}

export interface E2EGateResult {
  gateResultId: UUID;
  runId: UUID;
  gate: E2EGateKind;
  status: E2EGateStatus;
  checkedAt: Instant;
  checkedBy: string;
  summary: string;
  artifactRefs: readonly string[];
  details: Readonly<Record<string, unknown>>;
}

export interface PrivacyAttestation {
  accountPrivate: boolean;
  approvedFollowers: number;
  contactsSyncOff: boolean;
  crossPostingOff: boolean;
  testMediaOnly: boolean;
}

export interface E2EPublishPermit {
  permitId: UUID;
  runId: UUID;
  intentId: UUID;
  accountId: string;
  releaseSha: string;
  issuedAt: Instant;
  expiresAt: Instant;
  issuedBy: string;
  tokenHash: string;
}

export interface E2EPublishPermitConsumption {
  permitId: UUID;
  consumedAt: Instant;
  consumedBy: string;
}

export interface HostPreflightCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface HostPreflightResult {
  checkedAt: Instant;
  ready: boolean;
  checks: readonly HostPreflightCheck[];
}
