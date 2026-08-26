import type { Instant, UUID } from "./model.js";
import type { IncidentKind } from "./operations.js";

export type EvidenceArtifactDisposition = "INCLUDED_TEXT" | "OMITTED_BINARY" | "OMITTED_UNSAFE" | "MISSING";

export interface RedactionFinding {
  kind: "SECRET" | "COOKIE" | "AUTH_HEADER" | "EMAIL" | "PHONE" | "HANDLE" | "QUERY_SECRET" | "HTML_FIELD" | "PATH" | "IDENTIFIER";
  replacements: number;
}

export interface EvidenceArtifactManifestItem {
  ref: string;
  disposition: EvidenceArtifactDisposition;
  mediaType: string;
  byteLength?: number;
  sha256?: string;
  sanitizedText?: string;
  note?: string;
}

export interface IncidentEvidenceBundle {
  bundleId: UUID;
  incidentId: UUID;
  capturedAt: Instant;
  releaseSha: string;
  adapterVersion: string;
  redactionPolicyVersion: string;
  incidentKind: IncidentKind;
  incidentSummary: string;
  sanitizedContext: Readonly<Record<string, unknown>>;
  artifacts: readonly EvidenceArtifactManifestItem[];
  redactionFindings: readonly RedactionFinding[];
}

export type AiIncidentClassification =
  | "SELECTOR_DRIFT"
  | "UI_WORKFLOW_DRIFT"
  | "TRANSIENT_TECHNICAL"
  | "AUTHENTICATION_REQUIRED"
  | "ACCOUNT_IDENTITY_RISK"
  | "POLICY_OR_COPYRIGHT"
  | "PUBLISH_OUTCOME_UNCERTAIN"
  | "SOURCE_DATA_ISSUE"
  | "UNKNOWN";

export type ProposedRepairKind =
  | "SELECTOR_CONFIG_CHANGE"
  | "UI_WORKFLOW_CONFIG_CHANGE"
  | "WAIT_CONDITION_CHANGE"
  | "CODE_CHANGE"
  | "NO_AUTOMATED_REPAIR";

export interface AiDiagnosis {
  diagnosisId: UUID;
  bundleId: UUID;
  incidentId: UUID;
  createdAt: Instant;
  classification: AiIncidentClassification;
  confidence: number;
  rootCause: string;
  evidenceRationale: readonly string[];
  proposedRepairKind: ProposedRepairKind;
  requiresHuman: boolean;
  securityNotes: readonly string[];
}

export type RepairPolicyDecision = "AUTO_CANDIDATE" | "ENGINEERING_REVIEW_REQUIRED" | "HUMAN_ONLY" | "PROHIBITED";

export interface RepairPolicyVerdict {
  decision: RepairPolicyDecision;
  reason: string;
  allowedPathPrefixes: readonly string[];
  deniedPathPrefixes: readonly string[];
  requireRegressionTest: boolean;
  allowPrepareOnlyReplay: boolean;
}

export interface RepairProposal {
  proposalId: UUID;
  diagnosisId: UUID;
  incidentId: UUID;
  createdAt: Instant;
  title: string;
  summary: string;
  unifiedDiff: string;
  changedFiles: readonly string[];
  regressionTestFiles: readonly string[];
  requestedTestCommands: readonly string[];
}

export type RepairGateKind = "POLICY" | "PATCH_SCOPE" | "REGRESSION" | "FULL_SUITE" | "PREPARE_ONLY" | "HUMAN_REVIEW";
export type RepairGateStatus = "PASS" | "FAIL" | "PENDING" | "NOT_APPLICABLE";

export interface RepairGateResult {
  gateResultId: UUID;
  proposalId: UUID;
  gate: RepairGateKind;
  status: RepairGateStatus;
  checkedAt: Instant;
  summary: string;
  artifactRefs: readonly string[];
}

export interface RepairBranchRecord {
  branchRecordId: UUID;
  proposalId: UUID;
  createdAt: Instant;
  branchName: string;
  baseRef: string;
  worktreePath: string;
  headSha?: string;
}

export interface RepairExecutionReport {
  proposal?: RepairProposal;
  verdict: RepairPolicyVerdict;
  branch?: RepairBranchRecord;
  gates: readonly RepairGateResult[];
  readyForHumanReview: boolean;
  productionPromotionAllowed: false;
}
