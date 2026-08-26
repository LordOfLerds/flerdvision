import { DatabaseSync } from "node:sqlite";
import type {
  ContentItem,
  PublicationIntent,
  PublishAttempt,
  SourceObservation,
  VerificationDecision,
  VerificationEvidence,
  VerifiedPublication,
  Instant
} from "../../domain/model.js";
import type { BrowserIdentity, SessionHealthCheck, SocialAccount, StoredBrowserIdentity, StoredSocialAccount } from "../../domain/browser-identity.js";
import { normalizeSocialHandle } from "../../domain/browser-identity.js";
import type { BrowserIdentityStorePort } from "../../domain/browser-identity-ports.js";
import type { PlatformCapabilityProbe } from "../../domain/platform-ui.js";
import type { PlatformCapabilityStorePort } from "../../domain/platform-ui-ports.js";
import type { PublishAttemptStorePort, VerificationStorePort } from "../../domain/verification-ports.js";
import type { OperationsStorePort } from "../../domain/operations-ports.js";
import type { RepairStorePort } from "../../domain/repair-ports.js";
import type { AiDiagnosis, IncidentEvidenceBundle, RepairBranchRecord, RepairGateResult, RepairProposal } from "../../domain/repair.js";
import type {
  HumanActionRecord,
  Incident,
  IncidentCandidate,
  KillSwitch,
  KillSwitchScopeType,
  NotificationDelivery,
  NotificationMessage,
  NotificationReceipt
} from "../../domain/operations.js";
import type { PublicationState } from "../../domain/states.js";
import { transition as assertTransition } from "../../domain/states.js";
import type {
  Actor,
  AuditEvent,
  ControlPlaneSummary,
  CreateIntentResult,
  ScheduleReservation,
  StoredPublicationIntent,
  WorkerLease
} from "../../domain/control-plane.js";
import type { ControlPlaneStorePort } from "../../domain/control-plane-ports.js";
import type { IngressStorePort } from "../../domain/ingress-ports.js";
import type {
  CreateContentResult,
  ObserveSourceResult,
  SourceDispositionRecord,
  SourceObservationState,
  StoredContentItem,
  StoredSourceObservation
} from "../../domain/ingress.js";

const ALL_STATES: readonly PublicationState[] = [
  "PLANNED",
  "READY",
  "SCHEDULED",
  "PREPARING",
  "PUBLISHING",
  "VERIFYING",
  "PUBLISH_UNCERTAIN",
  "RETRY_WAIT",
  "VERIFIED",
  "BLOCKED",
  "WAIVED"
];

interface IntentRow {
  intent_id: string;
  content_id: string;
  creator_id: string;
  platform: PublicationIntent["platform"];
  account_id: string;
  format: PublicationIntent["format"];
  copy_version_id: string;
  scheduled_for: string;
  idempotency_key: string;
  state: PublicationState;
  created_at: string;
  updated_at: string;
}

interface ReservationRow {
  reservation_id: string;
  intent_id: string;
  account_id: string;
  platform: PublicationIntent["platform"];
  business_date: string;
  slot_key: string;
  target_at: string;
  window_start_at: string;
  window_end_at: string;
  created_at: string;
}

interface LeaseRow {
  resource_key: string;
  owner_id: string;
  acquired_at: string;
  heartbeat_at: string;
  expires_at: string;
}

interface EventRow {
  sequence: number;
  event_id: string;
  aggregate_type: AuditEvent["aggregateType"];
  aggregate_id: string;
  event_type: string;
  occurred_at: string;
  actor_type: Actor["type"];
  actor_id: string;
  from_state: PublicationState | null;
  to_state: PublicationState | null;
  payload_json: string;
}

interface SourceObservationRow {
  observation_id: string;
  source_id: string;
  external_object_id: string;
  observed_at: string;
  locator: string;
  media_fingerprint: string | null;
  metadata_json: string;
  state: SourceObservationState;
  first_observed_at: string;
  last_observed_at: string;
  seen_count: number;
  content_id: string | null;
  reason: string | null;
}

interface ContentItemRow {
  content_id: string;
  accepted_from_observation_id: string;
  creator_id: string;
  media_fingerprint: string;
  immutable_media_ref: string;
  scheduled_business_date: string | null;
  metadata_json: string;
  created_at: string;
}

interface SourceDispositionRow {
  source_observation_id: string;
  state: SourceDispositionRecord["state"];
  publication_ids_json: string;
  reason: string | null;
  updated_at: string;
}

interface SocialAccountRow {
  account_id: string;
  creator_id: string | null;
  platform: SocialAccount["platform"];
  expected_handle: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

interface BrowserIdentityRow {
  identity_id: string;
  account_id: string;
  platform: BrowserIdentity["platform"];
  profile_key: string;
  expected_handle: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

interface SessionHealthRow {
  sequence: number;
  check_id: string;
  identity_id: string;
  checked_at: string;
  state: SessionHealthCheck["state"];
  expected_handle: string;
  observed_handle: string | null;
  current_url: string | null;
  note: string | null;
}

interface PlatformCapabilityProbeRow {
  sequence: number;
  probe_id: string;
  account_id: string;
  identity_id: string;
  platform: PlatformCapabilityProbe["platform"];
  probed_at: string;
  capabilities_json: string;
  current_url: string | null;
  note: string | null;
}

interface PublishAttemptRow {
  attempt_id: string;
  intent_id: string;
  browser_identity_id: string;
  release_sha: string;
  started_at: string;
  irreversible_boundary_entered_at: string | null;
  final_action_invoked_at: string | null;
  finished_at: string | null;
  result: PublishAttempt["result"];
  media_sha256: string | null;
  preparation_artifact_refs_json: string;
  reached_final_action_boundary: number;
}

interface VerificationEvidenceRow {
  sequence: number;
  evidence_id: string;
  intent_id: string;
  attempt_id: string | null;
  kind: VerificationEvidence["kind"];
  observed_at: string;
  positive: number;
  locator: string | null;
  artifact_ref: string | null;
  note: string | null;
}

interface VerificationDecisionRow {
  sequence: number;
  decision_id: string;
  intent_id: string;
  attempt_id: string | null;
  decided_at: string;
  outcome: VerificationDecision["outcome"];
  policy_name: string;
  evidence_ids_json: string;
  reason: string;
}

interface VerifiedPublicationRow {
  sequence: number;
  publication_id: string;
  intent_id: string;
  verified_at: string;
  permalink: string | null;
  evidence_ids_json: string;
}

interface IncidentRow {
  incident_id: string;
  fingerprint: string;
  kind: Incident["kind"];
  severity: Incident["severity"];
  title: string;
  summary: string;
  scope_json: string;
  evidence_refs_json: string;
  metadata_json: string;
  status: Incident["status"];
  opened_at: string;
  last_observed_at: string;
  occurrence_count: number;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution_note: string | null;
}

interface HumanActionRow {
  sequence: number;
  action_id: string;
  kind: HumanActionRecord["kind"];
  occurred_at: string;
  operator_id: string;
  incident_id: string | null;
  intent_id: string | null;
  note: string | null;
  payload_json: string;
}

interface KillSwitchRow {
  scope_type: KillSwitchScopeType;
  scope_key: string;
  enabled: number;
  reason: string;
  updated_at: string;
  updated_by: string;
}

interface NotificationMessageRow {
  notification_id: string;
  dedupe_key: string;
  kind: NotificationMessage["kind"];
  severity: NotificationMessage["severity"];
  created_at: string;
  subject: string;
  body: string;
  incident_id: string | null;
  intent_id: string | null;
  account_id: string | null;
  metadata_json: string;
}

interface NotificationDeliveryRow {
  notification_id: string;
  channel_key: string;
  status: NotificationDelivery["status"];
  attempts: number;
  created_at: string;
  updated_at: string;
  last_attempt_at: string | null;
  external_message_id: string | null;
  error: string | null;
}

interface RepairBundleRow {
  sequence: number; bundle_id: string; incident_id: string; captured_at: string; release_sha: string; adapter_version: string;
  redaction_policy_version: string; incident_kind: IncidentEvidenceBundle["incidentKind"]; incident_summary: string;
  sanitized_context_json: string; artifacts_json: string; redaction_findings_json: string;
}

interface AiDiagnosisRow {
  sequence: number; diagnosis_id: string; bundle_id: string; incident_id: string; created_at: string;
  classification: AiDiagnosis["classification"]; confidence: number; root_cause: string; evidence_rationale_json: string;
  proposed_repair_kind: AiDiagnosis["proposedRepairKind"]; requires_human: number; security_notes_json: string;
}

interface RepairProposalRow {
  sequence: number; proposal_id: string; diagnosis_id: string; incident_id: string; created_at: string; title: string; summary: string;
  unified_diff: string; changed_files_json: string; regression_test_files_json: string; requested_test_commands_json: string;
}

interface RepairGateRow {
  sequence: number; gate_result_id: string; proposal_id: string; gate: RepairGateResult["gate"]; status: RepairGateResult["status"];
  checked_at: string; summary: string; artifact_refs_json: string;
}

interface RepairBranchRow {
  sequence: number; branch_record_id: string; proposal_id: string; created_at: string; branch_name: string; base_ref: string;
  worktree_path: string; head_sha: string | null;
}

export class IdempotencyConflictError extends Error {}
export class ScheduleConflictError extends Error {}
export class IntentNotFoundError extends Error {}
export class SourceObservationNotFoundError extends Error {}
export class SourceDecisionConflictError extends Error {}
export class ContentConflictError extends Error {}
export class SocialAccountConflictError extends Error {}
export class BrowserIdentityConflictError extends Error {}
export class PublishAttemptConflictError extends Error {}
export class VerificationEvidenceConflictError extends Error {}
export class VerificationDecisionConflictError extends Error {}
export class VerifiedPublicationConflictError extends Error {}
export class IncidentConflictError extends Error {}
export class HumanActionConflictError extends Error {}
export class KillSwitchConflictError extends Error {}
export class NotificationConflictError extends Error {}
export class RepairBundleConflictError extends Error {}
export class AiDiagnosisConflictError extends Error {}
export class RepairProposalConflictError extends Error {}
export class RepairGateConflictError extends Error {}
export class RepairBranchConflictError extends Error {}

function asIso(instant: Instant): Instant {
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid instant: ${instant}`);
  return date.toISOString();
}

function addSeconds(instant: Instant, seconds: number): Instant {
  return new Date(new Date(instant).getTime() + seconds * 1000).toISOString();
}

function newEventId(prefix: string): string {
  return `${prefix}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 12)}`;
}

function intentFromRow(row: IntentRow): StoredPublicationIntent {
  return {
    intent: {
      intentId: row.intent_id,
      contentId: row.content_id,
      creatorId: row.creator_id,
      platform: row.platform,
      accountId: row.account_id,
      format: row.format,
      copyVersionId: row.copy_version_id,
      scheduledFor: row.scheduled_for,
      idempotencyKey: row.idempotency_key
    },
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function reservationFromRow(row: ReservationRow): ScheduleReservation {
  return {
    reservationId: row.reservation_id,
    intentId: row.intent_id,
    accountId: row.account_id,
    platform: row.platform,
    businessDate: row.business_date,
    slotKey: row.slot_key,
    targetAt: row.target_at,
    windowStartAt: row.window_start_at,
    windowEndAt: row.window_end_at,
    createdAt: row.created_at
  };
}

function leaseFromRow(row: LeaseRow): WorkerLease {
  return {
    resourceKey: row.resource_key,
    ownerId: row.owner_id,
    acquiredAt: row.acquired_at,
    heartbeatAt: row.heartbeat_at,
    expiresAt: row.expires_at
  };
}

function eventFromRow(row: EventRow): AuditEvent {
  const event: AuditEvent = {
    sequence: row.sequence,
    eventId: row.event_id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    occurredAt: row.occurred_at,
    actor: { type: row.actor_type, id: row.actor_id },
    payload: JSON.parse(row.payload_json) as Record<string, unknown>
  };
  if (row.from_state !== null) Object.assign(event, { fromState: row.from_state });
  if (row.to_state !== null) Object.assign(event, { toState: row.to_state });
  return event;
}

function sourceObservationFromRow(row: SourceObservationRow): StoredSourceObservation {
  const observation: SourceObservation = {
    observationId: row.observation_id,
    sourceId: row.source_id,
    externalObjectId: row.external_object_id,
    observedAt: row.observed_at,
    locator: row.locator,
    metadata: JSON.parse(row.metadata_json) as Record<string, string>
  };
  if (row.media_fingerprint !== null) Object.assign(observation, { mediaFingerprint: row.media_fingerprint });

  const record: StoredSourceObservation = {
    observation,
    state: row.state,
    firstObservedAt: row.first_observed_at,
    lastObservedAt: row.last_observed_at,
    seenCount: row.seen_count
  };
  if (row.content_id !== null) Object.assign(record, { contentId: row.content_id });
  if (row.reason !== null) Object.assign(record, { reason: row.reason });
  return record;
}

function contentItemFromRow(row: ContentItemRow): StoredContentItem {
  const item: ContentItem = {
    contentId: row.content_id,
    acceptedFromObservationId: row.accepted_from_observation_id,
    creatorId: row.creator_id,
    mediaFingerprint: row.media_fingerprint,
    immutableMediaRef: row.immutable_media_ref,
    metadata: JSON.parse(row.metadata_json) as Record<string, string>
  };
  if (row.scheduled_business_date !== null) Object.assign(item, { scheduledBusinessDate: row.scheduled_business_date });
  return { item, createdAt: row.created_at };
}

function sourceDispositionFromRow(row: SourceDispositionRow): SourceDispositionRecord {
  const record: SourceDispositionRecord = {
    sourceObservationId: row.source_observation_id,
    state: row.state,
    publicationIds: JSON.parse(row.publication_ids_json) as string[],
    updatedAt: row.updated_at
  };
  if (row.reason !== null) Object.assign(record, { reason: row.reason });
  return record;
}


function socialAccountFromRow(row: SocialAccountRow): StoredSocialAccount {
  const account: SocialAccount = {
    accountId: row.account_id,
    platform: row.platform,
    expectedHandle: row.expected_handle,
    enabled: row.enabled === 1
  };
  if (row.creator_id !== null) Object.assign(account, { creatorId: row.creator_id });
  return { account, createdAt: row.created_at, updatedAt: row.updated_at };
}

function browserIdentityFromRow(row: BrowserIdentityRow): StoredBrowserIdentity {
  return {
    identity: {
      identityId: row.identity_id,
      accountId: row.account_id,
      platform: row.platform,
      profileKey: row.profile_key,
      expectedHandle: row.expected_handle,
      enabled: row.enabled === 1
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function sessionHealthFromRow(row: SessionHealthRow): SessionHealthCheck {
  const check: SessionHealthCheck = {
    checkId: row.check_id,
    identityId: row.identity_id,
    checkedAt: row.checked_at,
    state: row.state,
    expectedHandle: row.expected_handle
  };
  if (row.observed_handle !== null) Object.assign(check, { observedHandle: row.observed_handle });
  if (row.current_url !== null) Object.assign(check, { currentUrl: row.current_url });
  if (row.note !== null) Object.assign(check, { note: row.note });
  return check;
}

function platformCapabilityProbeFromRow(row: PlatformCapabilityProbeRow): PlatformCapabilityProbe {
  const probe: PlatformCapabilityProbe = {
    probeId: row.probe_id,
    accountId: row.account_id,
    identityId: row.identity_id,
    platform: row.platform,
    probedAt: row.probed_at,
    capabilities: JSON.parse(row.capabilities_json) as PlatformCapabilityProbe["capabilities"]
  };
  if (row.current_url !== null) Object.assign(probe, { currentUrl: row.current_url });
  if (row.note !== null) Object.assign(probe, { note: row.note });
  return probe;
}

function publishAttemptFromRow(row: PublishAttemptRow): PublishAttempt {
  const attempt: PublishAttempt = {
    attemptId: row.attempt_id,
    intentId: row.intent_id,
    browserIdentityId: row.browser_identity_id,
    releaseSha: row.release_sha,
    startedAt: row.started_at,
    result: row.result,
    preparationArtifactRefs: JSON.parse(row.preparation_artifact_refs_json) as string[],
    reachedFinalActionBoundary: row.reached_final_action_boundary === 1
  };
  if (row.irreversible_boundary_entered_at !== null) Object.assign(attempt, { irreversibleBoundaryEnteredAt: row.irreversible_boundary_entered_at });
  if (row.final_action_invoked_at !== null) Object.assign(attempt, { finalActionInvokedAt: row.final_action_invoked_at });
  if (row.finished_at !== null) Object.assign(attempt, { finishedAt: row.finished_at });
  if (row.media_sha256 !== null) Object.assign(attempt, { mediaSha256: row.media_sha256 });
  return attempt;
}

function verificationEvidenceFromRow(row: VerificationEvidenceRow): VerificationEvidence {
  const evidence: VerificationEvidence = {
    evidenceId: row.evidence_id,
    intentId: row.intent_id,
    kind: row.kind,
    observedAt: row.observed_at,
    positive: row.positive === 1
  };
  if (row.attempt_id !== null) Object.assign(evidence, { attemptId: row.attempt_id });
  if (row.locator !== null) Object.assign(evidence, { locator: row.locator });
  if (row.artifact_ref !== null) Object.assign(evidence, { artifactRef: row.artifact_ref });
  if (row.note !== null) Object.assign(evidence, { note: row.note });
  return evidence;
}

function verificationDecisionFromRow(row: VerificationDecisionRow): VerificationDecision {
  const decision: VerificationDecision = {
    decisionId: row.decision_id,
    intentId: row.intent_id,
    decidedAt: row.decided_at,
    outcome: row.outcome,
    policyName: row.policy_name,
    evidenceIds: JSON.parse(row.evidence_ids_json) as string[],
    reason: row.reason
  };
  if (row.attempt_id !== null) Object.assign(decision, { attemptId: row.attempt_id });
  return decision;
}

function verifiedPublicationFromRow(row: VerifiedPublicationRow): VerifiedPublication {
  const publication: VerifiedPublication = {
    publicationId: row.publication_id,
    intentId: row.intent_id,
    verifiedAt: row.verified_at,
    evidenceIds: JSON.parse(row.evidence_ids_json) as string[]
  };
  if (row.permalink !== null) Object.assign(publication, { permalink: row.permalink });
  return publication;
}

function incidentFromRow(row: IncidentRow): Incident {
  const incident: Incident = {
    incidentId: row.incident_id,
    fingerprint: row.fingerprint,
    kind: row.kind,
    severity: row.severity,
    title: row.title,
    summary: row.summary,
    scope: JSON.parse(row.scope_json) as Incident["scope"],
    evidenceRefs: JSON.parse(row.evidence_refs_json) as string[],
    metadata: JSON.parse(row.metadata_json) as Record<string, string>,
    status: row.status,
    openedAt: row.opened_at,
    lastObservedAt: row.last_observed_at,
    occurrenceCount: row.occurrence_count
  };
  if (row.acknowledged_at !== null) Object.assign(incident, { acknowledgedAt: row.acknowledged_at });
  if (row.acknowledged_by !== null) Object.assign(incident, { acknowledgedBy: row.acknowledged_by });
  if (row.resolved_at !== null) Object.assign(incident, { resolvedAt: row.resolved_at });
  if (row.resolved_by !== null) Object.assign(incident, { resolvedBy: row.resolved_by });
  if (row.resolution_note !== null) Object.assign(incident, { resolutionNote: row.resolution_note });
  return incident;
}

function humanActionFromRow(row: HumanActionRow): HumanActionRecord {
  const action: HumanActionRecord = {
    actionId: row.action_id,
    kind: row.kind,
    occurredAt: row.occurred_at,
    operatorId: row.operator_id,
    payload: JSON.parse(row.payload_json) as Record<string, string>
  };
  if (row.incident_id !== null) Object.assign(action, { incidentId: row.incident_id });
  if (row.intent_id !== null) Object.assign(action, { intentId: row.intent_id });
  if (row.note !== null) Object.assign(action, { note: row.note });
  return action;
}

function killSwitchFromRow(row: KillSwitchRow): KillSwitch {
  return {
    scopeType: row.scope_type,
    scopeKey: row.scope_key,
    enabled: row.enabled === 1,
    reason: row.reason,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by
  };
}

function notificationMessageFromRow(row: NotificationMessageRow): NotificationMessage {
  const message: NotificationMessage = {
    notificationId: row.notification_id,
    dedupeKey: row.dedupe_key,
    kind: row.kind,
    severity: row.severity,
    createdAt: row.created_at,
    subject: row.subject,
    body: row.body,
    metadata: JSON.parse(row.metadata_json) as Record<string, string>
  };
  if (row.incident_id !== null) Object.assign(message, { incidentId: row.incident_id });
  if (row.intent_id !== null) Object.assign(message, { intentId: row.intent_id });
  if (row.account_id !== null) Object.assign(message, { accountId: row.account_id });
  return message;
}

function notificationDeliveryFromRow(row: NotificationDeliveryRow): NotificationDelivery {
  const delivery: NotificationDelivery = {
    notificationId: row.notification_id,
    channelKey: row.channel_key,
    status: row.status,
    attempts: row.attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
  if (row.last_attempt_at !== null) Object.assign(delivery, { lastAttemptAt: row.last_attempt_at });
  if (row.external_message_id !== null) Object.assign(delivery, { externalMessageId: row.external_message_id });
  if (row.error !== null) Object.assign(delivery, { error: row.error });
  return delivery;
}

function repairBundleFromRow(row: RepairBundleRow): IncidentEvidenceBundle {
  return {
    bundleId: row.bundle_id, incidentId: row.incident_id, capturedAt: row.captured_at, releaseSha: row.release_sha,
    adapterVersion: row.adapter_version, redactionPolicyVersion: row.redaction_policy_version, incidentKind: row.incident_kind,
    incidentSummary: row.incident_summary, sanitizedContext: JSON.parse(row.sanitized_context_json) as Record<string, unknown>,
    artifacts: JSON.parse(row.artifacts_json) as IncidentEvidenceBundle["artifacts"],
    redactionFindings: JSON.parse(row.redaction_findings_json) as IncidentEvidenceBundle["redactionFindings"]
  };
}

function aiDiagnosisFromRow(row: AiDiagnosisRow): AiDiagnosis {
  return {
    diagnosisId: row.diagnosis_id, bundleId: row.bundle_id, incidentId: row.incident_id, createdAt: row.created_at,
    classification: row.classification, confidence: row.confidence, rootCause: row.root_cause,
    evidenceRationale: JSON.parse(row.evidence_rationale_json) as string[], proposedRepairKind: row.proposed_repair_kind,
    requiresHuman: row.requires_human === 1, securityNotes: JSON.parse(row.security_notes_json) as string[]
  };
}

function repairProposalFromRow(row: RepairProposalRow): RepairProposal {
  return {
    proposalId: row.proposal_id, diagnosisId: row.diagnosis_id, incidentId: row.incident_id, createdAt: row.created_at,
    title: row.title, summary: row.summary, unifiedDiff: row.unified_diff,
    changedFiles: JSON.parse(row.changed_files_json) as string[], regressionTestFiles: JSON.parse(row.regression_test_files_json) as string[],
    requestedTestCommands: JSON.parse(row.requested_test_commands_json) as string[]
  };
}

function repairGateFromRow(row: RepairGateRow): RepairGateResult {
  return { gateResultId: row.gate_result_id, proposalId: row.proposal_id, gate: row.gate, status: row.status, checkedAt: row.checked_at, summary: row.summary, artifactRefs: JSON.parse(row.artifact_refs_json) as string[] };
}

function repairBranchFromRow(row: RepairBranchRow): RepairBranchRecord {
  const record: RepairBranchRecord = { branchRecordId: row.branch_record_id, proposalId: row.proposal_id, createdAt: row.created_at, branchName: row.branch_name, baseRef: row.base_ref, worktreePath: row.worktree_path };
  if (row.head_sha !== null) Object.assign(record, { headSha: row.head_sha });
  return record;
}

function sameSocialAccount(existing: SocialAccount, candidate: SocialAccount): boolean {
  return (existing.creatorId ?? null) === (candidate.creatorId ?? null) &&
    existing.platform === candidate.platform &&
    normalizeSocialHandle(existing.expectedHandle) === normalizeSocialHandle(candidate.expectedHandle) &&
    existing.enabled === candidate.enabled;
}

function sameBrowserIdentity(existing: BrowserIdentity, candidate: BrowserIdentity): boolean {
  return existing.accountId === candidate.accountId &&
    existing.platform === candidate.platform &&
    existing.profileKey === candidate.profileKey &&
    normalizeSocialHandle(existing.expectedHandle) === normalizeSocialHandle(candidate.expectedHandle) &&
    existing.enabled === candidate.enabled;
}

function stableMetadata(metadata: Readonly<Record<string, string>>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(metadata).sort(([a], [b]) => a.localeCompare(b))));
}

function sameIntentPayload(existing: PublicationIntent, candidate: PublicationIntent): boolean {
  return (
    existing.contentId === candidate.contentId &&
    existing.creatorId === candidate.creatorId &&
    existing.platform === candidate.platform &&
    existing.accountId === candidate.accountId &&
    existing.format === candidate.format &&
    existing.copyVersionId === candidate.copyVersionId &&
    asIso(existing.scheduledFor) === asIso(candidate.scheduledFor)
  );
}

function samePreparedAttempt(existing: PublishAttempt, candidate: PublishAttempt): boolean {
  return existing.intentId === candidate.intentId &&
    existing.browserIdentityId === candidate.browserIdentityId &&
    existing.releaseSha === candidate.releaseSha &&
    asIso(existing.startedAt) === asIso(candidate.startedAt) &&
    (existing.mediaSha256 ?? null) === (candidate.mediaSha256 ?? null) &&
    JSON.stringify([...(existing.preparationArtifactRefs ?? [])]) === JSON.stringify([...(candidate.preparationArtifactRefs ?? [])]) &&
    Boolean(existing.reachedFinalActionBoundary) === Boolean(candidate.reachedFinalActionBoundary);
}

function sameVerificationEvidence(existing: VerificationEvidence, candidate: VerificationEvidence): boolean {
  return existing.intentId === candidate.intentId &&
    (existing.attemptId ?? null) === (candidate.attemptId ?? null) &&
    existing.kind === candidate.kind &&
    asIso(existing.observedAt) === asIso(candidate.observedAt) &&
    existing.positive === candidate.positive &&
    (existing.locator ?? null) === (candidate.locator ?? null) &&
    (existing.artifactRef ?? null) === (candidate.artifactRef ?? null) &&
    (existing.note ?? null) === (candidate.note ?? null);
}

function sameVerificationDecision(existing: VerificationDecision, candidate: VerificationDecision): boolean {
  return existing.intentId === candidate.intentId &&
    (existing.attemptId ?? null) === (candidate.attemptId ?? null) &&
    asIso(existing.decidedAt) === asIso(candidate.decidedAt) &&
    existing.outcome === candidate.outcome &&
    existing.policyName === candidate.policyName &&
    JSON.stringify([...existing.evidenceIds]) === JSON.stringify([...candidate.evidenceIds]) &&
    existing.reason === candidate.reason;
}

function sameVerifiedPublication(existing: VerifiedPublication, candidate: VerifiedPublication): boolean {
  return existing.intentId === candidate.intentId &&
    asIso(existing.verifiedAt) === asIso(candidate.verifiedAt) &&
    (existing.permalink ?? null) === (candidate.permalink ?? null) &&
    JSON.stringify([...existing.evidenceIds]) === JSON.stringify([...candidate.evidenceIds]);
}

export class SqliteControlPlaneStore implements ControlPlaneStorePort, IngressStorePort, BrowserIdentityStorePort, PlatformCapabilityStorePort, PublishAttemptStorePort, VerificationStorePort, OperationsStorePort, RepairStorePort {
  private readonly db: DatabaseSync;

  constructor(databasePath: string) {
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = FULL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);

    const migrationOne = this.db.prepare("SELECT version FROM schema_migrations WHERE version = 1").get();
    if (!migrationOne) {
      this.transaction(() => {
        this.db.exec(`
          CREATE TABLE publication_intents (
            intent_id TEXT PRIMARY KEY,
            content_id TEXT NOT NULL,
            creator_id TEXT NOT NULL,
            platform TEXT NOT NULL,
            account_id TEXT NOT NULL,
            format TEXT NOT NULL,
            copy_version_id TEXT NOT NULL,
            scheduled_for TEXT NOT NULL,
            idempotency_key TEXT NOT NULL UNIQUE,
            state TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );

          CREATE INDEX idx_publication_intents_state ON publication_intents(state);
          CREATE INDEX idx_publication_intents_account_schedule ON publication_intents(account_id, scheduled_for);

          CREATE TABLE schedule_reservations (
            reservation_id TEXT PRIMARY KEY,
            intent_id TEXT NOT NULL UNIQUE REFERENCES publication_intents(intent_id) ON DELETE RESTRICT,
            account_id TEXT NOT NULL,
            platform TEXT NOT NULL,
            business_date TEXT NOT NULL,
            slot_key TEXT NOT NULL,
            target_at TEXT NOT NULL,
            window_start_at TEXT NOT NULL,
            window_end_at TEXT NOT NULL,
            created_at TEXT NOT NULL,
            UNIQUE(account_id, target_at)
          );

          CREATE INDEX idx_schedule_due ON schedule_reservations(window_start_at, window_end_at);
          CREATE INDEX idx_schedule_account_date ON schedule_reservations(account_id, business_date);

          CREATE TABLE worker_leases (
            resource_key TEXT PRIMARY KEY,
            owner_id TEXT NOT NULL,
            acquired_at TEXT NOT NULL,
            heartbeat_at TEXT NOT NULL,
            expires_at TEXT NOT NULL
          );

          CREATE INDEX idx_worker_leases_expiry ON worker_leases(expires_at);

          CREATE TABLE event_log (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id TEXT NOT NULL UNIQUE,
            aggregate_type TEXT NOT NULL,
            aggregate_id TEXT NOT NULL,
            event_type TEXT NOT NULL,
            occurred_at TEXT NOT NULL,
            actor_type TEXT NOT NULL,
            actor_id TEXT NOT NULL,
            from_state TEXT,
            to_state TEXT,
            payload_json TEXT NOT NULL
          );

          CREATE INDEX idx_event_aggregate ON event_log(aggregate_type, aggregate_id, sequence);
          CREATE INDEX idx_event_time ON event_log(occurred_at);

          CREATE TRIGGER event_log_no_update
          BEFORE UPDATE ON event_log
          BEGIN
            SELECT RAISE(ABORT, 'event_log is append-only');
          END;

          CREATE TRIGGER event_log_no_delete
          BEFORE DELETE ON event_log
          BEGIN
            SELECT RAISE(ABORT, 'event_log is append-only');
          END;
        `);
        this.db.prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)")
          .run(1, "initial durable control plane", new Date().toISOString());
      });
    }

    const migrationTwo = this.db.prepare("SELECT version FROM schema_migrations WHERE version = 2").get();
    if (!migrationTwo) {
      this.transaction(() => {
        this.db.exec(`
          CREATE TABLE source_observations (
            observation_id TEXT PRIMARY KEY,
            source_id TEXT NOT NULL,
            external_object_id TEXT NOT NULL,
            observed_at TEXT NOT NULL,
            locator TEXT NOT NULL,
            media_fingerprint TEXT,
            metadata_json TEXT NOT NULL,
            state TEXT NOT NULL,
            first_observed_at TEXT NOT NULL,
            last_observed_at TEXT NOT NULL,
            seen_count INTEGER NOT NULL,
            content_id TEXT,
            reason TEXT,
            UNIQUE(source_id, external_object_id)
          );

          CREATE INDEX idx_source_observation_state ON source_observations(state);
          CREATE INDEX idx_source_observation_external ON source_observations(source_id, external_object_id);

          CREATE TABLE content_items (
            content_id TEXT PRIMARY KEY,
            accepted_from_observation_id TEXT NOT NULL UNIQUE REFERENCES source_observations(observation_id) ON DELETE RESTRICT,
            creator_id TEXT NOT NULL,
            media_fingerprint TEXT NOT NULL,
            immutable_media_ref TEXT NOT NULL,
            scheduled_business_date TEXT,
            metadata_json TEXT NOT NULL,
            created_at TEXT NOT NULL
          );

          CREATE INDEX idx_content_creator_date ON content_items(creator_id, scheduled_business_date);

          CREATE TABLE source_dispositions (
            source_observation_id TEXT PRIMARY KEY REFERENCES source_observations(observation_id) ON DELETE RESTRICT,
            state TEXT NOT NULL,
            publication_ids_json TEXT NOT NULL,
            reason TEXT,
            updated_at TEXT NOT NULL
          );
        `);
        this.db.prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)")
          .run(2, "pluggable ingress and source disposition", new Date().toISOString());
      });
    }

    const migrationThree = this.db.prepare("SELECT version FROM schema_migrations WHERE version = 3").get();
    if (!migrationThree) {
      this.transaction(() => {
        this.db.exec(`
          CREATE TABLE social_accounts (
            account_id TEXT PRIMARY KEY,
            creator_id TEXT,
            platform TEXT NOT NULL,
            expected_handle TEXT NOT NULL,
            enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );

          CREATE INDEX idx_social_accounts_platform ON social_accounts(platform, enabled);

          CREATE TABLE browser_identities (
            identity_id TEXT PRIMARY KEY,
            account_id TEXT NOT NULL UNIQUE REFERENCES social_accounts(account_id) ON DELETE RESTRICT,
            platform TEXT NOT NULL,
            profile_key TEXT NOT NULL UNIQUE,
            expected_handle TEXT NOT NULL,
            enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );

          CREATE INDEX idx_browser_identity_platform ON browser_identities(platform, enabled);

          CREATE TABLE session_health_checks (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            check_id TEXT NOT NULL UNIQUE,
            identity_id TEXT NOT NULL REFERENCES browser_identities(identity_id) ON DELETE RESTRICT,
            checked_at TEXT NOT NULL,
            state TEXT NOT NULL,
            expected_handle TEXT NOT NULL,
            observed_handle TEXT,
            current_url TEXT,
            note TEXT
          );

          CREATE INDEX idx_session_health_identity_time ON session_health_checks(identity_id, checked_at DESC, sequence DESC);

          CREATE TRIGGER session_health_no_update
          BEFORE UPDATE ON session_health_checks
          BEGIN
            SELECT RAISE(ABORT, 'session_health_checks is append-only');
          END;

          CREATE TRIGGER session_health_no_delete
          BEFORE DELETE ON session_health_checks
          BEGIN
            SELECT RAISE(ABORT, 'session_health_checks is append-only');
          END;
        `);
        this.db.prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)")
          .run(3, "browser identity and session health", new Date().toISOString());
      });
    }

    const migrationFour = this.db.prepare("SELECT version FROM schema_migrations WHERE version = 4").get();
    if (!migrationFour) {
      this.transaction(() => {
        this.db.exec(`
          CREATE TABLE platform_capability_probes (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            probe_id TEXT NOT NULL UNIQUE,
            account_id TEXT NOT NULL REFERENCES social_accounts(account_id) ON DELETE RESTRICT,
            identity_id TEXT NOT NULL REFERENCES browser_identities(identity_id) ON DELETE RESTRICT,
            platform TEXT NOT NULL,
            probed_at TEXT NOT NULL,
            capabilities_json TEXT NOT NULL,
            current_url TEXT,
            note TEXT
          );

          CREATE INDEX idx_platform_capability_account_time
            ON platform_capability_probes(account_id, probed_at DESC, sequence DESC);

          CREATE TRIGGER platform_capability_no_update
          BEFORE UPDATE ON platform_capability_probes
          BEGIN
            SELECT RAISE(ABORT, 'platform_capability_probes is append-only');
          END;

          CREATE TRIGGER platform_capability_no_delete
          BEFORE DELETE ON platform_capability_probes
          BEGIN
            SELECT RAISE(ABORT, 'platform_capability_probes is append-only');
          END;
        `);
        this.db.prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)")
          .run(4, "platform UI capability probes", new Date().toISOString());
      });
    }

    const migrationFive = this.db.prepare("SELECT version FROM schema_migrations WHERE version = 5").get();
    if (!migrationFive) {
      this.transaction(() => {
        this.db.exec(`
          CREATE TABLE publish_attempts (
            attempt_id TEXT PRIMARY KEY,
            intent_id TEXT NOT NULL REFERENCES publication_intents(intent_id) ON DELETE RESTRICT,
            browser_identity_id TEXT NOT NULL,
            release_sha TEXT NOT NULL,
            started_at TEXT NOT NULL,
            irreversible_boundary_entered_at TEXT,
            final_action_invoked_at TEXT,
            finished_at TEXT,
            result TEXT NOT NULL,
            media_sha256 TEXT,
            preparation_artifact_refs_json TEXT NOT NULL,
            reached_final_action_boundary INTEGER NOT NULL CHECK(reached_final_action_boundary IN (0, 1))
          );

          CREATE INDEX idx_publish_attempt_intent_time
            ON publish_attempts(intent_id, started_at, attempt_id);

          CREATE TABLE verification_evidence (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            evidence_id TEXT NOT NULL UNIQUE,
            intent_id TEXT NOT NULL REFERENCES publication_intents(intent_id) ON DELETE RESTRICT,
            attempt_id TEXT REFERENCES publish_attempts(attempt_id) ON DELETE RESTRICT,
            kind TEXT NOT NULL,
            observed_at TEXT NOT NULL,
            positive INTEGER NOT NULL CHECK(positive IN (0, 1)),
            locator TEXT,
            artifact_ref TEXT,
            note TEXT
          );

          CREATE INDEX idx_verification_evidence_intent_time
            ON verification_evidence(intent_id, observed_at, sequence);
          CREATE INDEX idx_verification_evidence_attempt_time
            ON verification_evidence(attempt_id, observed_at, sequence);

          CREATE TRIGGER verification_evidence_no_update
          BEFORE UPDATE ON verification_evidence
          BEGIN
            SELECT RAISE(ABORT, 'verification_evidence is append-only');
          END;

          CREATE TRIGGER verification_evidence_no_delete
          BEFORE DELETE ON verification_evidence
          BEGIN
            SELECT RAISE(ABORT, 'verification_evidence is append-only');
          END;

          CREATE TABLE verification_decisions (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            decision_id TEXT NOT NULL UNIQUE,
            intent_id TEXT NOT NULL REFERENCES publication_intents(intent_id) ON DELETE RESTRICT,
            attempt_id TEXT REFERENCES publish_attempts(attempt_id) ON DELETE RESTRICT,
            decided_at TEXT NOT NULL,
            outcome TEXT NOT NULL,
            policy_name TEXT NOT NULL,
            evidence_ids_json TEXT NOT NULL,
            reason TEXT NOT NULL
          );

          CREATE INDEX idx_verification_decision_intent_time
            ON verification_decisions(intent_id, decided_at, sequence);

          CREATE TRIGGER verification_decision_no_update
          BEFORE UPDATE ON verification_decisions
          BEGIN
            SELECT RAISE(ABORT, 'verification_decisions is append-only');
          END;

          CREATE TRIGGER verification_decision_no_delete
          BEFORE DELETE ON verification_decisions
          BEGIN
            SELECT RAISE(ABORT, 'verification_decisions is append-only');
          END;

          CREATE TABLE verified_publications (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            publication_id TEXT NOT NULL UNIQUE,
            intent_id TEXT NOT NULL UNIQUE REFERENCES publication_intents(intent_id) ON DELETE RESTRICT,
            verified_at TEXT NOT NULL,
            permalink TEXT,
            evidence_ids_json TEXT NOT NULL
          );

          CREATE TRIGGER verified_publication_no_update
          BEFORE UPDATE ON verified_publications
          BEGIN
            SELECT RAISE(ABORT, 'verified_publications is append-only');
          END;

          CREATE TRIGGER verified_publication_no_delete
          BEFORE DELETE ON verified_publications
          BEGIN
            SELECT RAISE(ABORT, 'verified_publications is append-only');
          END;
        `);
        this.db.prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)")
          .run(5, "publish attempts verification evidence and reconciliation", new Date().toISOString());
      });
    }

    const migrationSix = this.db.prepare("SELECT version FROM schema_migrations WHERE version = 6").get();
    if (!migrationSix) {
      this.transaction(() => {
        this.db.exec(`
          CREATE TABLE incidents (
            incident_id TEXT PRIMARY KEY,
            fingerprint TEXT NOT NULL UNIQUE,
            kind TEXT NOT NULL,
            severity TEXT NOT NULL,
            title TEXT NOT NULL,
            summary TEXT NOT NULL,
            scope_json TEXT NOT NULL,
            evidence_refs_json TEXT NOT NULL,
            metadata_json TEXT NOT NULL,
            status TEXT NOT NULL,
            opened_at TEXT NOT NULL,
            last_observed_at TEXT NOT NULL,
            occurrence_count INTEGER NOT NULL CHECK(occurrence_count >= 1),
            acknowledged_at TEXT,
            acknowledged_by TEXT,
            resolved_at TEXT,
            resolved_by TEXT,
            resolution_note TEXT
          );

          CREATE INDEX idx_incidents_status_severity ON incidents(status, severity, last_observed_at);

          CREATE TABLE human_actions (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            action_id TEXT NOT NULL UNIQUE,
            kind TEXT NOT NULL,
            occurred_at TEXT NOT NULL,
            operator_id TEXT NOT NULL,
            incident_id TEXT REFERENCES incidents(incident_id) ON DELETE RESTRICT,
            intent_id TEXT REFERENCES publication_intents(intent_id) ON DELETE RESTRICT,
            note TEXT,
            payload_json TEXT NOT NULL
          );

          CREATE INDEX idx_human_actions_intent ON human_actions(intent_id, occurred_at, sequence);
          CREATE INDEX idx_human_actions_incident ON human_actions(incident_id, occurred_at, sequence);

          CREATE TRIGGER human_actions_no_update
          BEFORE UPDATE ON human_actions
          BEGIN
            SELECT RAISE(ABORT, 'human_actions is append-only');
          END;

          CREATE TRIGGER human_actions_no_delete
          BEFORE DELETE ON human_actions
          BEGIN
            SELECT RAISE(ABORT, 'human_actions is append-only');
          END;

          CREATE TABLE kill_switches (
            scope_type TEXT NOT NULL,
            scope_key TEXT NOT NULL,
            enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
            reason TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            updated_by TEXT NOT NULL,
            PRIMARY KEY(scope_type, scope_key)
          );

          CREATE INDEX idx_kill_switch_enabled ON kill_switches(enabled, scope_type, scope_key);

          CREATE TABLE notification_messages (
            notification_id TEXT PRIMARY KEY,
            dedupe_key TEXT NOT NULL UNIQUE,
            kind TEXT NOT NULL,
            severity TEXT NOT NULL,
            created_at TEXT NOT NULL,
            subject TEXT NOT NULL,
            body TEXT NOT NULL,
            incident_id TEXT REFERENCES incidents(incident_id) ON DELETE RESTRICT,
            intent_id TEXT REFERENCES publication_intents(intent_id) ON DELETE RESTRICT,
            account_id TEXT,
            metadata_json TEXT NOT NULL
          );

          CREATE TRIGGER notification_messages_no_update
          BEFORE UPDATE ON notification_messages
          BEGIN
            SELECT RAISE(ABORT, 'notification_messages is append-only');
          END;

          CREATE TRIGGER notification_messages_no_delete
          BEFORE DELETE ON notification_messages
          BEGIN
            SELECT RAISE(ABORT, 'notification_messages is append-only');
          END;

          CREATE TABLE notification_deliveries (
            notification_id TEXT NOT NULL REFERENCES notification_messages(notification_id) ON DELETE RESTRICT,
            channel_key TEXT NOT NULL,
            status TEXT NOT NULL,
            attempts INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            last_attempt_at TEXT,
            external_message_id TEXT,
            error TEXT,
            PRIMARY KEY(notification_id, channel_key)
          );

          CREATE INDEX idx_notification_delivery_status ON notification_deliveries(status, updated_at);
        `);
        this.db.prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)")
          .run(6, "operations incidents notifications and kill switches", new Date().toISOString());
      });
    }

    const migrationSeven = this.db.prepare("SELECT version FROM schema_migrations WHERE version = 7").get();
    if (!migrationSeven) {
      this.transaction(() => {
        this.db.exec(`
          CREATE TABLE incident_evidence_bundles (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            bundle_id TEXT NOT NULL UNIQUE,
            incident_id TEXT NOT NULL REFERENCES incidents(incident_id) ON DELETE RESTRICT,
            captured_at TEXT NOT NULL,
            release_sha TEXT NOT NULL,
            adapter_version TEXT NOT NULL,
            redaction_policy_version TEXT NOT NULL,
            incident_kind TEXT NOT NULL,
            incident_summary TEXT NOT NULL,
            sanitized_context_json TEXT NOT NULL,
            artifacts_json TEXT NOT NULL,
            redaction_findings_json TEXT NOT NULL
          );
          CREATE INDEX idx_repair_bundle_incident ON incident_evidence_bundles(incident_id, captured_at, sequence);

          CREATE TABLE ai_diagnoses (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            diagnosis_id TEXT NOT NULL UNIQUE,
            bundle_id TEXT NOT NULL REFERENCES incident_evidence_bundles(bundle_id) ON DELETE RESTRICT,
            incident_id TEXT NOT NULL REFERENCES incidents(incident_id) ON DELETE RESTRICT,
            created_at TEXT NOT NULL,
            classification TEXT NOT NULL,
            confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
            root_cause TEXT NOT NULL,
            evidence_rationale_json TEXT NOT NULL,
            proposed_repair_kind TEXT NOT NULL,
            requires_human INTEGER NOT NULL CHECK(requires_human IN (0,1)),
            security_notes_json TEXT NOT NULL
          );
          CREATE INDEX idx_ai_diagnosis_incident ON ai_diagnoses(incident_id, created_at, sequence);

          CREATE TABLE repair_proposals (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            proposal_id TEXT NOT NULL UNIQUE,
            diagnosis_id TEXT NOT NULL REFERENCES ai_diagnoses(diagnosis_id) ON DELETE RESTRICT,
            incident_id TEXT NOT NULL REFERENCES incidents(incident_id) ON DELETE RESTRICT,
            created_at TEXT NOT NULL,
            title TEXT NOT NULL,
            summary TEXT NOT NULL,
            unified_diff TEXT NOT NULL,
            changed_files_json TEXT NOT NULL,
            regression_test_files_json TEXT NOT NULL,
            requested_test_commands_json TEXT NOT NULL
          );
          CREATE INDEX idx_repair_proposal_incident ON repair_proposals(incident_id, created_at, sequence);

          CREATE TABLE repair_gate_results (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            gate_result_id TEXT NOT NULL UNIQUE,
            proposal_id TEXT NOT NULL REFERENCES repair_proposals(proposal_id) ON DELETE RESTRICT,
            gate TEXT NOT NULL, status TEXT NOT NULL, checked_at TEXT NOT NULL, summary TEXT NOT NULL, artifact_refs_json TEXT NOT NULL
          );
          CREATE INDEX idx_repair_gate_proposal ON repair_gate_results(proposal_id, checked_at, sequence);

          CREATE TABLE repair_branches (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            branch_record_id TEXT NOT NULL UNIQUE,
            proposal_id TEXT NOT NULL UNIQUE REFERENCES repair_proposals(proposal_id) ON DELETE RESTRICT,
            created_at TEXT NOT NULL, branch_name TEXT NOT NULL UNIQUE, base_ref TEXT NOT NULL, worktree_path TEXT NOT NULL, head_sha TEXT
          );

          CREATE TRIGGER incident_evidence_bundles_no_update BEFORE UPDATE ON incident_evidence_bundles BEGIN SELECT RAISE(ABORT, 'incident_evidence_bundles is append-only'); END;
          CREATE TRIGGER incident_evidence_bundles_no_delete BEFORE DELETE ON incident_evidence_bundles BEGIN SELECT RAISE(ABORT, 'incident_evidence_bundles is append-only'); END;
          CREATE TRIGGER ai_diagnoses_no_update BEFORE UPDATE ON ai_diagnoses BEGIN SELECT RAISE(ABORT, 'ai_diagnoses is append-only'); END;
          CREATE TRIGGER ai_diagnoses_no_delete BEFORE DELETE ON ai_diagnoses BEGIN SELECT RAISE(ABORT, 'ai_diagnoses is append-only'); END;
          CREATE TRIGGER repair_proposals_no_update BEFORE UPDATE ON repair_proposals BEGIN SELECT RAISE(ABORT, 'repair_proposals is append-only'); END;
          CREATE TRIGGER repair_proposals_no_delete BEFORE DELETE ON repair_proposals BEGIN SELECT RAISE(ABORT, 'repair_proposals is append-only'); END;
          CREATE TRIGGER repair_gate_results_no_update BEFORE UPDATE ON repair_gate_results BEGIN SELECT RAISE(ABORT, 'repair_gate_results is append-only'); END;
          CREATE TRIGGER repair_gate_results_no_delete BEFORE DELETE ON repair_gate_results BEGIN SELECT RAISE(ABORT, 'repair_gate_results is append-only'); END;
          CREATE TRIGGER repair_branches_no_update BEFORE UPDATE ON repair_branches BEGIN SELECT RAISE(ABORT, 'repair_branches is append-only'); END;
          CREATE TRIGGER repair_branches_no_delete BEFORE DELETE ON repair_branches BEGIN SELECT RAISE(ABORT, 'repair_branches is append-only'); END;
        `);
        this.db.prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)")
          .run(7, "AI repair evidence diagnosis proposals and gates", new Date().toISOString());
      });
    }
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const result = fn();
      this.db.exec("COMMIT;");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  private appendEvent(params: {
    aggregateType: AuditEvent["aggregateType"];
    aggregateId: string;
    eventType: string;
    occurredAt: Instant;
    actor: Actor;
    fromState?: PublicationState;
    toState?: PublicationState;
    payload?: Readonly<Record<string, unknown>>;
  }): void {
    this.db.prepare(`
      INSERT INTO event_log(
        event_id, aggregate_type, aggregate_id, event_type, occurred_at,
        actor_type, actor_id, from_state, to_state, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      newEventId("event"),
      params.aggregateType,
      params.aggregateId,
      params.eventType,
      asIso(params.occurredAt),
      params.actor.type,
      params.actor.id,
      params.fromState ?? null,
      params.toState ?? null,
      JSON.stringify(params.payload ?? {})
    );
  }

  createOrGetIntent(intent: PublicationIntent, now: Instant, actor: Actor): CreateIntentResult {
    const normalizedIntent: PublicationIntent = { ...intent, scheduledFor: asIso(intent.scheduledFor) };
    return this.transaction(() => {
      const byKey = this.db.prepare("SELECT * FROM publication_intents WHERE idempotency_key = ?")
        .get(intent.idempotencyKey) as IntentRow | undefined;
      if (byKey) {
        const existing = intentFromRow(byKey);
        if (!sameIntentPayload(existing.intent, normalizedIntent)) {
          throw new IdempotencyConflictError(
            `Idempotency key ${intent.idempotencyKey} already belongs to a different publication payload`
          );
        }
        return { created: false, record: existing };
      }

      const byId = this.db.prepare("SELECT * FROM publication_intents WHERE intent_id = ?")
        .get(intent.intentId) as IntentRow | undefined;
      if (byId) {
        throw new IdempotencyConflictError(`Intent id ${intent.intentId} already exists with another idempotency key`);
      }

      const timestamp = asIso(now);
      this.db.prepare(`
        INSERT INTO publication_intents(
          intent_id, content_id, creator_id, platform, account_id, format,
          copy_version_id, scheduled_for, idempotency_key, state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        normalizedIntent.intentId,
        normalizedIntent.contentId,
        normalizedIntent.creatorId,
        normalizedIntent.platform,
        normalizedIntent.accountId,
        normalizedIntent.format,
        normalizedIntent.copyVersionId,
        normalizedIntent.scheduledFor,
        normalizedIntent.idempotencyKey,
        "PLANNED",
        timestamp,
        timestamp
      );

      this.appendEvent({
        aggregateType: "publication_intent",
        aggregateId: normalizedIntent.intentId,
        eventType: "intent.created",
        occurredAt: timestamp,
        actor,
        toState: "PLANNED",
        payload: { idempotencyKey: normalizedIntent.idempotencyKey }
      });

      return { created: true, record: this.getIntentOrThrow(normalizedIntent.intentId) };
    });
  }

  getIntent(intentId: string): StoredPublicationIntent | null {
    const row = this.db.prepare("SELECT * FROM publication_intents WHERE intent_id = ?").get(intentId) as IntentRow | undefined;
    return row ? intentFromRow(row) : null;
  }

  private getIntentOrThrow(intentId: string): StoredPublicationIntent {
    const record = this.getIntent(intentId);
    if (!record) throw new IntentNotFoundError(`Publication intent not found: ${intentId}`);
    return record;
  }

  listIntents(states?: readonly PublicationState[]): readonly StoredPublicationIntent[] {
    if (!states || states.length === 0) {
      return (this.db.prepare("SELECT * FROM publication_intents ORDER BY scheduled_for, intent_id").all() as IntentRow[])
        .map(intentFromRow);
    }
    const placeholders = states.map(() => "?").join(",");
    return (this.db.prepare(`SELECT * FROM publication_intents WHERE state IN (${placeholders}) ORDER BY scheduled_for, intent_id`)
      .all(...states) as IntentRow[]).map(intentFromRow);
  }

  transitionIntent(intentId: string, to: PublicationState, now: Instant, actor: Actor, reason?: string): StoredPublicationIntent {
    return this.transaction(() => this.transitionIntentInsideTransaction(intentId, to, now, actor, reason));
  }

  private transitionIntentInsideTransaction(
    intentId: string,
    to: PublicationState,
    now: Instant,
    actor: Actor,
    reason?: string
  ): StoredPublicationIntent {
    const current = this.getIntentOrThrow(intentId);
    assertTransition(current.state, to);
    const timestamp = asIso(now);
    const result = this.db.prepare("UPDATE publication_intents SET state = ?, updated_at = ? WHERE intent_id = ? AND state = ?")
      .run(to, timestamp, intentId, current.state);
    if (result.changes !== 1) throw new Error(`Concurrent state change detected for ${intentId}`);

    this.appendEvent({
      aggregateType: "publication_intent",
      aggregateId: intentId,
      eventType: "intent.transitioned",
      occurredAt: timestamp,
      actor,
      fromState: current.state,
      toState: to,
      payload: reason ? { reason } : {}
    });
    return this.getIntentOrThrow(intentId);
  }

  reserveIntent(intentId: string, reservation: ScheduleReservation, now: Instant, actor: Actor): ScheduleReservation {
    return this.transaction(() => {
      const intent = this.getIntentOrThrow(intentId);
      if (intent.state !== "READY") {
        throw new ScheduleConflictError(`Intent ${intentId} must be READY before reservation, got ${intent.state}`);
      }
      if (reservation.intentId !== intentId || reservation.accountId !== intent.intent.accountId) {
        throw new ScheduleConflictError(`Reservation does not match intent ${intentId}`);
      }

      const existing = this.getReservationForIntent(intentId);
      if (existing) {
        if (
          existing.targetAt === reservation.targetAt &&
          existing.accountId === reservation.accountId &&
          existing.slotKey === reservation.slotKey
        ) {
          return existing;
        }
        throw new ScheduleConflictError(`Intent ${intentId} already has a different reservation`);
      }

      const collision = this.db.prepare("SELECT * FROM schedule_reservations WHERE account_id = ? AND target_at = ?")
        .get(reservation.accountId, asIso(reservation.targetAt)) as ReservationRow | undefined;
      if (collision) {
        throw new ScheduleConflictError(
          `Account ${reservation.accountId} already has a reservation at ${reservation.targetAt}`
        );
      }

      this.db.prepare(`
        INSERT INTO schedule_reservations(
          reservation_id, intent_id, account_id, platform, business_date, slot_key,
          target_at, window_start_at, window_end_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        reservation.reservationId,
        reservation.intentId,
        reservation.accountId,
        reservation.platform,
        reservation.businessDate,
        reservation.slotKey,
        asIso(reservation.targetAt),
        asIso(reservation.windowStartAt),
        asIso(reservation.windowEndAt),
        asIso(reservation.createdAt)
      );

      this.appendEvent({
        aggregateType: "schedule_reservation",
        aggregateId: reservation.reservationId,
        eventType: "schedule.reserved",
        occurredAt: now,
        actor,
        payload: {
          intentId,
          accountId: reservation.accountId,
          slotKey: reservation.slotKey,
          targetAt: asIso(reservation.targetAt)
        }
      });
      this.transitionIntentInsideTransaction(intentId, "SCHEDULED", now, actor, "schedule_reserved");
      return this.getReservationForIntent(intentId) ?? reservation;
    });
  }

  getReservationForIntent(intentId: string): ScheduleReservation | null {
    const row = this.db.prepare("SELECT * FROM schedule_reservations WHERE intent_id = ?")
      .get(intentId) as ReservationRow | undefined;
    return row ? reservationFromRow(row) : null;
  }

  listReservations(accountId?: string, businessDate?: string): readonly ScheduleReservation[] {
    let sql = "SELECT * FROM schedule_reservations";
    const params: string[] = [];
    const filters: string[] = [];
    if (accountId) {
      filters.push("account_id = ?");
      params.push(accountId);
    }
    if (businessDate) {
      filters.push("business_date = ?");
      params.push(businessDate);
    }
    if (filters.length > 0) sql += ` WHERE ${filters.join(" AND ")}`;
    sql += " ORDER BY target_at, reservation_id";
    return (this.db.prepare(sql).all(...params) as ReservationRow[]).map(reservationFromRow);
  }

  listDueReservations(now: Instant): readonly ScheduleReservation[] {
    const timestamp = asIso(now);
    return (this.db.prepare(`
      SELECT r.*
      FROM schedule_reservations r
      JOIN publication_intents i ON i.intent_id = r.intent_id
      WHERE i.state = 'SCHEDULED'
        AND r.window_start_at <= ?
        AND r.window_end_at >= ?
      ORDER BY r.target_at, r.reservation_id
    `).all(timestamp, timestamp) as ReservationRow[]).map(reservationFromRow);
  }

  listMissedReservations(now: Instant): readonly ScheduleReservation[] {
    const timestamp = asIso(now);
    return (this.db.prepare(`
      SELECT r.*
      FROM schedule_reservations r
      JOIN publication_intents i ON i.intent_id = r.intent_id
      WHERE i.state = 'SCHEDULED'
        AND r.window_end_at < ?
      ORDER BY r.window_end_at, r.reservation_id
    `).all(timestamp) as ReservationRow[]).map(reservationFromRow);
  }

  acquireLease(resourceKey: string, ownerId: string, now: Instant, ttlSeconds: number, actor: Actor): WorkerLease | null {
    if (ttlSeconds <= 0) throw new Error("Lease TTL must be positive");
    return this.transaction(() => {
      const timestamp = asIso(now);
      const existing = this.getLease(resourceKey);
      if (existing && existing.expiresAt > timestamp && existing.ownerId !== ownerId) return null;

      const expiresAt = addSeconds(timestamp, ttlSeconds);
      if (existing) {
        this.db.prepare(`
          UPDATE worker_leases
          SET owner_id = ?, acquired_at = ?, heartbeat_at = ?, expires_at = ?
          WHERE resource_key = ?
        `).run(ownerId, timestamp, timestamp, expiresAt, resourceKey);
      } else {
        this.db.prepare(`
          INSERT INTO worker_leases(resource_key, owner_id, acquired_at, heartbeat_at, expires_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(resourceKey, ownerId, timestamp, timestamp, expiresAt);
      }

      this.appendEvent({
        aggregateType: "worker_lease",
        aggregateId: resourceKey,
        eventType: existing ? "lease.reacquired" : "lease.acquired",
        occurredAt: timestamp,
        actor,
        payload: { ownerId, expiresAt }
      });
      return this.getLease(resourceKey);
    });
  }

  heartbeatLease(resourceKey: string, ownerId: string, now: Instant, ttlSeconds: number, actor: Actor): WorkerLease | null {
    if (ttlSeconds <= 0) throw new Error("Lease TTL must be positive");
    return this.transaction(() => {
      const timestamp = asIso(now);
      const existing = this.getLease(resourceKey);
      if (!existing || existing.ownerId !== ownerId || existing.expiresAt <= timestamp) return null;
      const expiresAt = addSeconds(timestamp, ttlSeconds);
      this.db.prepare("UPDATE worker_leases SET heartbeat_at = ?, expires_at = ? WHERE resource_key = ? AND owner_id = ?")
        .run(timestamp, expiresAt, resourceKey, ownerId);
      this.appendEvent({
        aggregateType: "worker_lease",
        aggregateId: resourceKey,
        eventType: "lease.heartbeat",
        occurredAt: timestamp,
        actor,
        payload: { ownerId, expiresAt }
      });
      return this.getLease(resourceKey);
    });
  }

  releaseLease(resourceKey: string, ownerId: string, now: Instant, actor: Actor): boolean {
    return this.transaction(() => {
      const existing = this.getLease(resourceKey);
      if (!existing || existing.ownerId !== ownerId) return false;
      this.appendEvent({
        aggregateType: "worker_lease",
        aggregateId: resourceKey,
        eventType: "lease.released",
        occurredAt: now,
        actor,
        payload: { ownerId }
      });
      const result = this.db.prepare("DELETE FROM worker_leases WHERE resource_key = ? AND owner_id = ?")
        .run(resourceKey, ownerId);
      return result.changes === 1;
    });
  }

  getLease(resourceKey: string): WorkerLease | null {
    const row = this.db.prepare("SELECT * FROM worker_leases WHERE resource_key = ?")
      .get(resourceKey) as LeaseRow | undefined;
    return row ? leaseFromRow(row) : null;
  }

  listActiveLeases(now: Instant): readonly WorkerLease[] {
    return (this.db.prepare("SELECT * FROM worker_leases WHERE expires_at > ? ORDER BY resource_key")
      .all(asIso(now)) as LeaseRow[]).map(leaseFromRow);
  }

  reapExpiredLeases(now: Instant, actor: Actor): number {
    return this.transaction(() => {
      const timestamp = asIso(now);
      const expired = (this.db.prepare("SELECT * FROM worker_leases WHERE expires_at <= ? ORDER BY resource_key")
        .all(timestamp) as LeaseRow[]).map(leaseFromRow);
      for (const lease of expired) {
        this.appendEvent({
          aggregateType: "worker_lease",
          aggregateId: lease.resourceKey,
          eventType: "lease.expired",
          occurredAt: timestamp,
          actor,
          payload: { previousOwnerId: lease.ownerId, expiredAt: lease.expiresAt }
        });
      }
      this.db.prepare("DELETE FROM worker_leases WHERE expires_at <= ?").run(timestamp);
      return expired.length;
    });
  }

  listEvents(aggregateType?: AuditEvent["aggregateType"], aggregateId?: string): readonly AuditEvent[] {
    let sql = "SELECT * FROM event_log";
    const params: string[] = [];
    const filters: string[] = [];
    if (aggregateType) {
      filters.push("aggregate_type = ?");
      params.push(aggregateType);
    }
    if (aggregateId) {
      filters.push("aggregate_id = ?");
      params.push(aggregateId);
    }
    if (filters.length > 0) sql += ` WHERE ${filters.join(" AND ")}`;
    sql += " ORDER BY sequence";
    return (this.db.prepare(sql).all(...params) as EventRow[]).map(eventFromRow);
  }

  observeOrGetSource(observation: SourceObservation, now: Instant, actor: Actor): ObserveSourceResult {
    return this.transaction(() => {
      const timestamp = asIso(now);
      const observedAt = asIso(observation.observedAt);
      const existingRow = this.db.prepare(
        "SELECT * FROM source_observations WHERE source_id = ? AND external_object_id = ?"
      ).get(observation.sourceId, observation.externalObjectId) as SourceObservationRow | undefined;

      if (existingRow) {
        const existing = sourceObservationFromRow(existingRow);
        if (existing.observation.observationId !== observation.observationId) {
          const reason = `Observation identity mismatch for ${observation.sourceId}/${observation.externalObjectId}`;
          this.appendEvent({
            aggregateType: "source_observation",
            aggregateId: existing.observation.observationId,
            eventType: "source.conflict",
            occurredAt: timestamp,
            actor,
            payload: { reason, candidateObservationId: observation.observationId }
          });
          return { status: "conflict", record: existing, reason };
        }
        if (
          existing.observation.mediaFingerprint &&
          observation.mediaFingerprint &&
          existing.observation.mediaFingerprint !== observation.mediaFingerprint
        ) {
          const reason = `Source object changed media fingerprint after first observation`;
          this.appendEvent({
            aggregateType: "source_observation",
            aggregateId: existing.observation.observationId,
            eventType: "source.media_mutation_conflict",
            occurredAt: timestamp,
            actor,
            payload: {
              reason,
              existingFingerprint: existing.observation.mediaFingerprint,
              candidateFingerprint: observation.mediaFingerprint
            }
          });
          return { status: "conflict", record: existing, reason };
        }

        this.db.prepare(
          "UPDATE source_observations SET last_observed_at = ?, seen_count = seen_count + 1 WHERE observation_id = ?"
        ).run(timestamp, existing.observation.observationId);
        this.appendEvent({
          aggregateType: "source_observation",
          aggregateId: existing.observation.observationId,
          eventType: "source.seen_again",
          occurredAt: timestamp,
          actor,
          payload: { seenCount: existing.seenCount + 1 }
        });
        const updated = this.getSourceObservation(existing.observation.observationId);
        if (!updated) throw new Error(`Failed to reload source observation ${existing.observation.observationId}`);
        return { status: "duplicate", record: updated };
      }

      const byObservationId = this.db.prepare("SELECT * FROM source_observations WHERE observation_id = ?")
        .get(observation.observationId) as SourceObservationRow | undefined;
      if (byObservationId) {
        const existing = sourceObservationFromRow(byObservationId);
        const reason = `Observation id ${observation.observationId} already belongs to another source object`;
        this.appendEvent({
          aggregateType: "source_observation",
          aggregateId: observation.observationId,
          eventType: "source.conflict",
          occurredAt: timestamp,
          actor,
          payload: { reason }
        });
        return { status: "conflict", record: existing, reason };
      }

      this.db.prepare(`
        INSERT INTO source_observations(
          observation_id, source_id, external_object_id, observed_at, locator, media_fingerprint, metadata_json,
          state, first_observed_at, last_observed_at, seen_count, content_id, reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        observation.observationId,
        observation.sourceId,
        observation.externalObjectId,
        observedAt,
        observation.locator,
        observation.mediaFingerprint ?? null,
        stableMetadata(observation.metadata),
        "OBSERVED",
        timestamp,
        timestamp,
        1,
        null,
        null
      );
      this.appendEvent({
        aggregateType: "source_observation",
        aggregateId: observation.observationId,
        eventType: "source.observed",
        occurredAt: timestamp,
        actor,
        payload: { sourceId: observation.sourceId, externalObjectId: observation.externalObjectId }
      });
      const created = this.getSourceObservation(observation.observationId);
      if (!created) throw new Error(`Failed to reload source observation ${observation.observationId}`);
      return { status: "created", record: created };
    });
  }

  getSourceObservation(observationId: string): StoredSourceObservation | null {
    const row = this.db.prepare("SELECT * FROM source_observations WHERE observation_id = ?")
      .get(observationId) as SourceObservationRow | undefined;
    return row ? sourceObservationFromRow(row) : null;
  }

  listSourceObservations(states?: readonly SourceObservationState[]): readonly StoredSourceObservation[] {
    if (!states || states.length === 0) {
      return (this.db.prepare(
        "SELECT * FROM source_observations ORDER BY first_observed_at, observation_id"
      ).all() as SourceObservationRow[]).map(sourceObservationFromRow);
    }
    const placeholders = states.map(() => "?").join(",");
    return (this.db.prepare(
      `SELECT * FROM source_observations WHERE state IN (${placeholders}) ORDER BY first_observed_at, observation_id`
    ).all(...states) as SourceObservationRow[]).map(sourceObservationFromRow);
  }

  decideSourceObservation(
    observationId: string,
    decision: Exclude<SourceObservationState, "OBSERVED">,
    now: Instant,
    actor: Actor,
    options?: { contentId?: string; reason?: string }
  ): StoredSourceObservation {
    return this.transaction(() => {
      const current = this.getSourceObservation(observationId);
      if (!current) throw new SourceObservationNotFoundError(`Source observation not found: ${observationId}`);
      if (current.state !== "OBSERVED") {
        const same =
          current.state === decision &&
          (options?.contentId === undefined || current.contentId === options.contentId) &&
          (options?.reason === undefined || current.reason === options.reason);
        if (same) return current;
        throw new SourceDecisionConflictError(
          `Source observation ${observationId} already decided as ${current.state}`
        );
      }
      if (decision === "ACCEPTED" && !options?.contentId) {
        throw new SourceDecisionConflictError(`ACCEPTED source observation ${observationId} requires contentId`);
      }
      const timestamp = asIso(now);
      const result = this.db.prepare(
        "UPDATE source_observations SET state = ?, content_id = ?, reason = ? WHERE observation_id = ? AND state = 'OBSERVED'"
      ).run(decision, options?.contentId ?? null, options?.reason ?? null, observationId);
      if (result.changes !== 1) throw new SourceDecisionConflictError(`Concurrent source decision for ${observationId}`);
      this.appendEvent({
        aggregateType: "source_observation",
        aggregateId: observationId,
        eventType: `source.${decision.toLowerCase()}`,
        occurredAt: timestamp,
        actor,
        payload: { ...(options?.contentId ? { contentId: options.contentId } : {}), ...(options?.reason ? { reason: options.reason } : {}) }
      });
      const updated = this.getSourceObservation(observationId);
      if (!updated) throw new Error(`Failed to reload source observation ${observationId}`);
      return updated;
    });
  }

  createOrGetContent(item: ContentItem, now: Instant, actor: Actor): CreateContentResult {
    return this.transaction(() => {
      const byObservation = this.db.prepare(
        "SELECT * FROM content_items WHERE accepted_from_observation_id = ?"
      ).get(item.acceptedFromObservationId) as ContentItemRow | undefined;
      if (byObservation) {
        const existing = contentItemFromRow(byObservation);
        const same =
          existing.item.contentId === item.contentId &&
          existing.item.creatorId === item.creatorId &&
          existing.item.mediaFingerprint === item.mediaFingerprint &&
          existing.item.immutableMediaRef === item.immutableMediaRef &&
          existing.item.scheduledBusinessDate === item.scheduledBusinessDate &&
          stableMetadata(existing.item.metadata) === stableMetadata(item.metadata);
        if (!same) throw new ContentConflictError(
          `Observation ${item.acceptedFromObservationId} already materialized as different content`
        );
        return { created: false, record: existing };
      }

      const byId = this.db.prepare("SELECT * FROM content_items WHERE content_id = ?")
        .get(item.contentId) as ContentItemRow | undefined;
      if (byId) throw new ContentConflictError(`Content id ${item.contentId} already exists`);

      const timestamp = asIso(now);
      this.db.prepare(`
        INSERT INTO content_items(
          content_id, accepted_from_observation_id, creator_id, media_fingerprint, immutable_media_ref,
          scheduled_business_date, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        item.contentId,
        item.acceptedFromObservationId,
        item.creatorId,
        item.mediaFingerprint,
        item.immutableMediaRef,
        item.scheduledBusinessDate ?? null,
        stableMetadata(item.metadata),
        timestamp
      );
      this.appendEvent({
        aggregateType: "content_item",
        aggregateId: item.contentId,
        eventType: "content.created",
        occurredAt: timestamp,
        actor,
        payload: { observationId: item.acceptedFromObservationId, creatorId: item.creatorId }
      });
      const created = this.getContentItem(item.contentId);
      if (!created) throw new Error(`Failed to reload content item ${item.contentId}`);
      return { created: true, record: created };
    });
  }

  getContentItem(contentId: string): StoredContentItem | null {
    const row = this.db.prepare("SELECT * FROM content_items WHERE content_id = ?")
      .get(contentId) as ContentItemRow | undefined;
    return row ? contentItemFromRow(row) : null;
  }

  listContentItems(): readonly StoredContentItem[] {
    return (this.db.prepare("SELECT * FROM content_items ORDER BY created_at, content_id").all() as ContentItemRow[])
      .map(contentItemFromRow);
  }

  getSourceDisposition(observationId: string): SourceDispositionRecord | null {
    const row = this.db.prepare("SELECT * FROM source_dispositions WHERE source_observation_id = ?")
      .get(observationId) as SourceDispositionRow | undefined;
    return row ? sourceDispositionFromRow(row) : null;
  }

  recordSourceDisposition(record: SourceDispositionRecord, actor: Actor): SourceDispositionRecord {
    return this.transaction(() => {
      const existing = this.getSourceDisposition(record.sourceObservationId);
      const normalizedPublications = [...record.publicationIds].sort();
      if (existing) {
        const same =
          existing.state === record.state &&
          JSON.stringify([...existing.publicationIds].sort()) === JSON.stringify(normalizedPublications) &&
          existing.reason === record.reason;
        if (same) return existing;
        throw new SourceDecisionConflictError(
          `Source disposition ${record.sourceObservationId} already recorded as ${existing.state}`
        );
      }
      const timestamp = asIso(record.updatedAt);
      this.db.prepare(`
        INSERT INTO source_dispositions(source_observation_id, state, publication_ids_json, reason, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        record.sourceObservationId,
        record.state,
        JSON.stringify(normalizedPublications),
        record.reason ?? null,
        timestamp
      );
      this.appendEvent({
        aggregateType: "source_disposition",
        aggregateId: record.sourceObservationId,
        eventType: `source_disposition.${record.state.toLowerCase()}`,
        occurredAt: timestamp,
        actor,
        payload: { publicationIds: normalizedPublications, ...(record.reason ? { reason: record.reason } : {}) }
      });
      const created = this.getSourceDisposition(record.sourceObservationId);
      if (!created) throw new Error(`Failed to reload source disposition ${record.sourceObservationId}`);
      return created;
    });
  }

  summary(now: Instant): ControlPlaneSummary {
    const states = Object.fromEntries(ALL_STATES.map((state) => [state, 0])) as Record<PublicationState, number>;
    const rows = this.db.prepare("SELECT state, COUNT(*) AS count FROM publication_intents GROUP BY state").all() as Array<{
      state: PublicationState;
      count: number;
    }>;
    for (const row of rows) states[row.state] = Number(row.count);
    const scheduledOpen = Number((this.db.prepare("SELECT COUNT(*) AS count FROM publication_intents WHERE state = 'SCHEDULED'").get() as { count: number }).count);
    return {
      generatedAt: asIso(now),
      states,
      activeLeases: this.listActiveLeases(now).length,
      scheduledOpen,
      dueNow: this.listDueReservations(now).length,
      missedWindows: this.listMissedReservations(now).length
    };
  }

  registerSocialAccount(account: SocialAccount, now: Instant, actor: Actor): { created: boolean; record: StoredSocialAccount } {
    const normalized: SocialAccount = {
      ...account,
      expectedHandle: normalizeSocialHandle(account.expectedHandle)
    };
    return this.transaction(() => {
      const existingRow = this.db.prepare("SELECT * FROM social_accounts WHERE account_id = ?").get(account.accountId) as SocialAccountRow | undefined;
      if (existingRow) {
        const existing = socialAccountFromRow(existingRow);
        if (!sameSocialAccount(existing.account, normalized)) {
          throw new SocialAccountConflictError(`Social account ${account.accountId} already exists with different configuration`);
        }
        return { created: false, record: existing };
      }
      const timestamp = asIso(now);
      this.db.prepare(`
        INSERT INTO social_accounts(account_id, creator_id, platform, expected_handle, enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        normalized.accountId,
        normalized.creatorId ?? null,
        normalized.platform,
        normalized.expectedHandle,
        normalized.enabled ? 1 : 0,
        timestamp,
        timestamp
      );
      this.appendEvent({
        aggregateType: "social_account", aggregateId: normalized.accountId, eventType: "social_account.registered",
        occurredAt: timestamp, actor, payload: { platform: normalized.platform, enabled: normalized.enabled }
      });
      return { created: true, record: this.getSocialAccount(normalized.accountId)! };
    });
  }

  getSocialAccount(accountId: string): StoredSocialAccount | null {
    const row = this.db.prepare("SELECT * FROM social_accounts WHERE account_id = ?").get(accountId) as SocialAccountRow | undefined;
    return row ? socialAccountFromRow(row) : null;
  }

  listSocialAccounts(): readonly StoredSocialAccount[] {
    return (this.db.prepare("SELECT * FROM social_accounts ORDER BY account_id").all() as SocialAccountRow[]).map(socialAccountFromRow);
  }

  registerBrowserIdentity(identity: BrowserIdentity, now: Instant, actor: Actor): { created: boolean; record: StoredBrowserIdentity } {
    const normalized: BrowserIdentity = { ...identity, expectedHandle: normalizeSocialHandle(identity.expectedHandle) };
    return this.transaction(() => {
      const account = this.getSocialAccount(identity.accountId);
      if (!account) throw new BrowserIdentityConflictError(`Social account ${identity.accountId} must exist before browser identity registration`);
      if (account.account.platform !== normalized.platform) {
        throw new BrowserIdentityConflictError(`Browser identity platform ${normalized.platform} does not match account ${account.account.platform}`);
      }
      if (normalizeSocialHandle(account.account.expectedHandle) !== normalized.expectedHandle) {
        throw new BrowserIdentityConflictError("Browser identity expectedHandle does not match social account expectedHandle");
      }
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/.test(normalized.profileKey) || normalized.profileKey.includes("..")) {
        throw new BrowserIdentityConflictError(`Unsafe browser profile key: ${normalized.profileKey}`);
      }

      const existingRow = this.db.prepare("SELECT * FROM browser_identities WHERE identity_id = ?").get(identity.identityId) as BrowserIdentityRow | undefined;
      if (existingRow) {
        const existing = browserIdentityFromRow(existingRow);
        if (!sameBrowserIdentity(existing.identity, normalized)) {
          throw new BrowserIdentityConflictError(`Browser identity ${identity.identityId} already exists with different configuration`);
        }
        return { created: false, record: existing };
      }
      const profileOwner = this.db.prepare("SELECT * FROM browser_identities WHERE profile_key = ?").get(normalized.profileKey) as BrowserIdentityRow | undefined;
      if (profileOwner) throw new BrowserIdentityConflictError(`Browser profile ${normalized.profileKey} already belongs to ${profileOwner.identity_id}`);
      const accountOwner = this.db.prepare("SELECT * FROM browser_identities WHERE account_id = ?").get(normalized.accountId) as BrowserIdentityRow | undefined;
      if (accountOwner) throw new BrowserIdentityConflictError(`Social account ${normalized.accountId} already has browser identity ${accountOwner.identity_id}`);

      const timestamp = asIso(now);
      this.db.prepare(`
        INSERT INTO browser_identities(identity_id, account_id, platform, profile_key, expected_handle, enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        normalized.identityId, normalized.accountId, normalized.platform, normalized.profileKey,
        normalized.expectedHandle, normalized.enabled ? 1 : 0, timestamp, timestamp
      );
      this.appendEvent({
        aggregateType: "browser_identity", aggregateId: normalized.identityId, eventType: "browser_identity.registered",
        occurredAt: timestamp, actor, payload: { accountId: normalized.accountId, platform: normalized.platform, profileKey: normalized.profileKey }
      });
      return { created: true, record: this.getBrowserIdentity(normalized.identityId)! };
    });
  }

  getBrowserIdentity(identityId: string): StoredBrowserIdentity | null {
    const row = this.db.prepare("SELECT * FROM browser_identities WHERE identity_id = ?").get(identityId) as BrowserIdentityRow | undefined;
    return row ? browserIdentityFromRow(row) : null;
  }

  listBrowserIdentities(): readonly StoredBrowserIdentity[] {
    return (this.db.prepare("SELECT * FROM browser_identities ORDER BY identity_id").all() as BrowserIdentityRow[]).map(browserIdentityFromRow);
  }

  recordSessionHealth(check: SessionHealthCheck, actor: Actor): SessionHealthCheck {
    return this.transaction(() => {
      const identity = this.getBrowserIdentity(check.identityId);
      if (!identity) throw new BrowserIdentityConflictError(`Unknown browser identity: ${check.identityId}`);
      const normalizedExpected = normalizeSocialHandle(check.expectedHandle);
      if (normalizedExpected !== normalizeSocialHandle(identity.identity.expectedHandle)) {
        throw new BrowserIdentityConflictError("Session health expectedHandle does not match browser identity");
      }
      const normalizedObserved = check.observedHandle ? normalizeSocialHandle(check.observedHandle) : undefined;
      const normalized: SessionHealthCheck = {
        ...check,
        checkedAt: asIso(check.checkedAt),
        expectedHandle: normalizedExpected,
        ...(normalizedObserved ? { observedHandle: normalizedObserved } : {})
      };
      this.db.prepare(`
        INSERT INTO session_health_checks(check_id, identity_id, checked_at, state, expected_handle, observed_handle, current_url, note)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        normalized.checkId, normalized.identityId, normalized.checkedAt, normalized.state, normalized.expectedHandle,
        normalized.observedHandle ?? null, normalized.currentUrl ?? null, normalized.note ?? null
      );
      this.appendEvent({
        aggregateType: "session_health", aggregateId: normalized.identityId, eventType: "session_health.checked",
        occurredAt: normalized.checkedAt, actor, payload: { state: normalized.state, observedHandle: normalized.observedHandle ?? null }
      });
      return normalized;
    });
  }

  latestSessionHealth(identityId: string): SessionHealthCheck | null {
    const row = this.db.prepare(`
      SELECT * FROM session_health_checks WHERE identity_id = ? ORDER BY checked_at DESC, sequence DESC LIMIT 1
    `).get(identityId) as SessionHealthRow | undefined;
    return row ? sessionHealthFromRow(row) : null;
  }

  listSessionHealth(identityId?: string): readonly SessionHealthCheck[] {
    const rows = identityId
      ? this.db.prepare("SELECT * FROM session_health_checks WHERE identity_id = ? ORDER BY checked_at, sequence").all(identityId) as SessionHealthRow[]
      : this.db.prepare("SELECT * FROM session_health_checks ORDER BY checked_at, sequence").all() as SessionHealthRow[];
    return rows.map(sessionHealthFromRow);
  }

  recordCapabilityProbe(probe: PlatformCapabilityProbe, actor: Actor): PlatformCapabilityProbe {
    return this.transaction(() => {
      const account = this.getSocialAccount(probe.accountId);
      const identity = this.getBrowserIdentity(probe.identityId);
      if (!account) throw new SocialAccountConflictError(`Unknown social account: ${probe.accountId}`);
      if (!identity) throw new BrowserIdentityConflictError(`Unknown browser identity: ${probe.identityId}`);
      if (identity.identity.accountId !== probe.accountId || account.account.platform !== probe.platform || identity.identity.platform !== probe.platform) {
        throw new BrowserIdentityConflictError("Capability probe account/identity/platform mismatch");
      }
      const normalized: PlatformCapabilityProbe = { ...probe, probedAt: asIso(probe.probedAt) };
      this.db.prepare(`
        INSERT INTO platform_capability_probes(
          probe_id, account_id, identity_id, platform, probed_at, capabilities_json, current_url, note
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        normalized.probeId, normalized.accountId, normalized.identityId, normalized.platform, normalized.probedAt,
        JSON.stringify(normalized.capabilities), normalized.currentUrl ?? null, normalized.note ?? null
      );
      this.appendEvent({
        aggregateType: "platform_capability", aggregateId: normalized.accountId, eventType: "platform_capability.probed",
        occurredAt: normalized.probedAt, actor, payload: { identityId: normalized.identityId, platform: normalized.platform, capabilities: normalized.capabilities }
      });
      return normalized;
    });
  }

  latestCapabilityProbe(accountId: string): PlatformCapabilityProbe | null {
    const row = this.db.prepare(`
      SELECT * FROM platform_capability_probes WHERE account_id = ? ORDER BY probed_at DESC, sequence DESC LIMIT 1
    `).get(accountId) as PlatformCapabilityProbeRow | undefined;
    return row ? platformCapabilityProbeFromRow(row) : null;
  }

  listCapabilityProbes(accountId?: string): readonly PlatformCapabilityProbe[] {
    const rows = accountId
      ? this.db.prepare("SELECT * FROM platform_capability_probes WHERE account_id = ? ORDER BY probed_at, sequence").all(accountId) as PlatformCapabilityProbeRow[]
      : this.db.prepare("SELECT * FROM platform_capability_probes ORDER BY probed_at, sequence").all() as PlatformCapabilityProbeRow[];
    return rows.map(platformCapabilityProbeFromRow);
  }


  recordPreparedAttempt(attempt: PublishAttempt, actor: Actor): PublishAttempt {
    if (attempt.result !== "prepared") throw new PublishAttemptConflictError("Prepared attempt must have result=prepared");
    if (!attempt.reachedFinalActionBoundary) throw new PublishAttemptConflictError("Prepared attempt must have reached the final-action boundary");
    if (attempt.irreversibleBoundaryEnteredAt || attempt.finalActionInvokedAt) {
      throw new PublishAttemptConflictError("Prepared attempt cannot already contain irreversible-action timestamps");
    }
    return this.transaction(() => {
      const intent = this.getIntent(attempt.intentId);
      if (!intent) throw new PublishAttemptConflictError(`Unknown publication intent: ${attempt.intentId}`);
      const identity = this.getBrowserIdentity(attempt.browserIdentityId);
      if (!identity) throw new PublishAttemptConflictError(`Unknown browser identity: ${attempt.browserIdentityId}`);
      if (identity.identity.accountId !== intent.intent.accountId) {
        throw new PublishAttemptConflictError("Publish attempt browser identity does not belong to the intent account");
      }
      const existingRow = this.db.prepare("SELECT * FROM publish_attempts WHERE attempt_id = ?").get(attempt.attemptId) as PublishAttemptRow | undefined;
      if (existingRow) {
        const existing = publishAttemptFromRow(existingRow);
        if (!samePreparedAttempt(existing, attempt)) {
          throw new PublishAttemptConflictError(`Publish attempt ${attempt.attemptId} already exists with different data`);
        }
        return existing;
      }
      this.db.prepare(`
        INSERT INTO publish_attempts(
          attempt_id, intent_id, browser_identity_id, release_sha, started_at,
          irreversible_boundary_entered_at, final_action_invoked_at, finished_at,
          result, media_sha256, preparation_artifact_refs_json, reached_final_action_boundary
        ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)
      `).run(
        attempt.attemptId,
        attempt.intentId,
        attempt.browserIdentityId,
        attempt.releaseSha,
        asIso(attempt.startedAt),
        attempt.finishedAt ? asIso(attempt.finishedAt) : null,
        attempt.result,
        attempt.mediaSha256 ?? null,
        JSON.stringify([...(attempt.preparationArtifactRefs ?? [])]),
        attempt.reachedFinalActionBoundary ? 1 : 0
      );
      this.appendEvent({
        aggregateType: "publish_attempt",
        aggregateId: attempt.attemptId,
        eventType: "publish_attempt.prepared",
        occurredAt: attempt.finishedAt ?? attempt.startedAt,
        actor,
        payload: { intentId: attempt.intentId, releaseSha: attempt.releaseSha, mediaSha256: attempt.mediaSha256 ?? null }
      });
      const created = this.getPublishAttempt(attempt.attemptId);
      if (!created) throw new Error(`Failed to reload publish attempt ${attempt.attemptId}`);
      return created;
    });
  }

  getPublishAttempt(attemptId: string): PublishAttempt | null {
    const row = this.db.prepare("SELECT * FROM publish_attempts WHERE attempt_id = ?").get(attemptId) as PublishAttemptRow | undefined;
    return row ? publishAttemptFromRow(row) : null;
  }

  listPublishAttempts(intentId?: string): readonly PublishAttempt[] {
    const rows = intentId
      ? this.db.prepare("SELECT * FROM publish_attempts WHERE intent_id = ? ORDER BY started_at, attempt_id").all(intentId) as PublishAttemptRow[]
      : this.db.prepare("SELECT * FROM publish_attempts ORDER BY started_at, attempt_id").all() as PublishAttemptRow[];
    return rows.map(publishAttemptFromRow);
  }

  enterIrreversibleBoundary(attemptId: string, at: Instant, actor: Actor): PublishAttempt {
    return this.transaction(() => {
      const attempt = this.getPublishAttempt(attemptId);
      if (!attempt) throw new PublishAttemptConflictError(`Unknown publish attempt: ${attemptId}`);
      if (attempt.result !== "prepared") throw new PublishAttemptConflictError(`Attempt ${attemptId} must be prepared before boundary entry, got ${attempt.result}`);
      const intent = this.getIntentOrThrow(attempt.intentId);
      if (intent.state !== "PREPARING") throw new PublishAttemptConflictError(`Intent ${attempt.intentId} must be PREPARING before boundary entry, got ${intent.state}`);
      const timestamp = asIso(at);
      const result = this.db.prepare(`
        UPDATE publish_attempts
        SET irreversible_boundary_entered_at = ?, result = 'boundary_entered'
        WHERE attempt_id = ? AND result = 'prepared' AND irreversible_boundary_entered_at IS NULL
      `).run(timestamp, attemptId);
      if (result.changes !== 1) throw new PublishAttemptConflictError(`Concurrent boundary entry for ${attemptId}`);
      this.appendEvent({
        aggregateType: "publish_attempt", aggregateId: attemptId, eventType: "publish_attempt.irreversible_boundary_entered",
        occurredAt: timestamp, actor, payload: { intentId: attempt.intentId }
      });
      this.transitionIntentInsideTransaction(attempt.intentId, "PUBLISHING", timestamp, actor, "irreversible_boundary_entered_before_ui_action");
      return this.getPublishAttempt(attemptId)!;
    });
  }

  markFinalActionInvoked(attemptId: string, at: Instant, actor: Actor): PublishAttempt {
    return this.transaction(() => {
      const attempt = this.getPublishAttempt(attemptId);
      if (!attempt) throw new PublishAttemptConflictError(`Unknown publish attempt: ${attemptId}`);
      if (attempt.result !== "boundary_entered") throw new PublishAttemptConflictError(`Attempt ${attemptId} must have entered boundary, got ${attempt.result}`);
      const intent = this.getIntentOrThrow(attempt.intentId);
      if (intent.state !== "PUBLISHING") throw new PublishAttemptConflictError(`Intent ${attempt.intentId} must be PUBLISHING, got ${intent.state}`);
      const timestamp = asIso(at);
      const result = this.db.prepare(`
        UPDATE publish_attempts SET final_action_invoked_at = ?, finished_at = ?, result = 'final_action_invoked'
        WHERE attempt_id = ? AND result = 'boundary_entered'
      `).run(timestamp, timestamp, attemptId);
      if (result.changes !== 1) throw new PublishAttemptConflictError(`Concurrent final-action update for ${attemptId}`);
      this.appendEvent({
        aggregateType: "publish_attempt", aggregateId: attemptId, eventType: "publish_attempt.final_action_invoked",
        occurredAt: timestamp, actor, payload: { intentId: attempt.intentId }
      });
      this.transitionIntentInsideTransaction(attempt.intentId, "VERIFYING", timestamp, actor, "final_action_returned_control_to_worker");
      return this.getPublishAttempt(attemptId)!;
    });
  }

  markAttemptUncertain(attemptId: string, at: Instant, actor: Actor, reason: string): PublishAttempt {
    return this.transaction(() => {
      const attempt = this.getPublishAttempt(attemptId);
      if (!attempt) throw new PublishAttemptConflictError(`Unknown publish attempt: ${attemptId}`);
      if (!attempt.irreversibleBoundaryEnteredAt && attempt.result !== "boundary_entered" && attempt.result !== "final_action_invoked" && attempt.result !== "uncertain") {
        throw new PublishAttemptConflictError(`Attempt ${attemptId} has not crossed the irreversible boundary`);
      }
      if (attempt.result === "uncertain") return attempt;
      const timestamp = asIso(at);
      this.db.prepare("UPDATE publish_attempts SET finished_at = ?, result = 'uncertain' WHERE attempt_id = ?")
        .run(timestamp, attemptId);
      this.appendEvent({
        aggregateType: "publish_attempt", aggregateId: attemptId, eventType: "publish_attempt.uncertain",
        occurredAt: timestamp, actor, payload: { intentId: attempt.intentId, reason }
      });
      const intent = this.getIntentOrThrow(attempt.intentId);
      if (intent.state === "PUBLISHING" || intent.state === "VERIFYING") {
        this.transitionIntentInsideTransaction(attempt.intentId, "PUBLISH_UNCERTAIN", timestamp, actor, reason);
      } else if (intent.state !== "PUBLISH_UNCERTAIN") {
        throw new PublishAttemptConflictError(`Cannot mark attempt uncertain while intent is ${intent.state}`);
      }
      return this.getPublishAttempt(attemptId)!;
    });
  }

  markAttemptFailed(attemptId: string, at: Instant, actor: Actor, reason: string): PublishAttempt {
    return this.transaction(() => {
      const attempt = this.getPublishAttempt(attemptId);
      if (!attempt) throw new PublishAttemptConflictError(`Unknown publish attempt: ${attemptId}`);
      if (attempt.irreversibleBoundaryEnteredAt || attempt.result === "boundary_entered" || attempt.result === "final_action_invoked" || attempt.result === "uncertain") {
        throw new PublishAttemptConflictError("A post-boundary failure must be marked uncertain, never safely failed");
      }
      const timestamp = asIso(at);
      this.db.prepare("UPDATE publish_attempts SET finished_at = ?, result = 'failed' WHERE attempt_id = ?")
        .run(timestamp, attemptId);
      this.appendEvent({
        aggregateType: "publish_attempt", aggregateId: attemptId, eventType: "publish_attempt.failed",
        occurredAt: timestamp, actor, payload: { intentId: attempt.intentId, reason }
      });
      const intent = this.getIntentOrThrow(attempt.intentId);
      if (intent.state === "PREPARING") this.transitionIntentInsideTransaction(attempt.intentId, "RETRY_WAIT", timestamp, actor, reason);
      return this.getPublishAttempt(attemptId)!;
    });
  }

  recordVerificationEvidence(evidence: VerificationEvidence, actor: Actor): VerificationEvidence {
    return this.transaction(() => {
      const intent = this.getIntent(evidence.intentId);
      if (!intent) throw new VerificationEvidenceConflictError(`Unknown publication intent: ${evidence.intentId}`);
      if (evidence.attemptId) {
        const attempt = this.getPublishAttempt(evidence.attemptId);
        if (!attempt) throw new VerificationEvidenceConflictError(`Unknown publish attempt: ${evidence.attemptId}`);
        if (attempt.intentId !== evidence.intentId) throw new VerificationEvidenceConflictError("Verification evidence intent/attempt mismatch");
      }
      const existingRow = this.db.prepare("SELECT * FROM verification_evidence WHERE evidence_id = ?").get(evidence.evidenceId) as VerificationEvidenceRow | undefined;
      if (existingRow) {
        const existing = verificationEvidenceFromRow(existingRow);
        if (!sameVerificationEvidence(existing, evidence)) throw new VerificationEvidenceConflictError(`Evidence ${evidence.evidenceId} conflicts with existing record`);
        return existing;
      }
      const normalized: VerificationEvidence = { ...evidence, observedAt: asIso(evidence.observedAt) };
      this.db.prepare(`
        INSERT INTO verification_evidence(evidence_id, intent_id, attempt_id, kind, observed_at, positive, locator, artifact_ref, note)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        normalized.evidenceId, normalized.intentId, normalized.attemptId ?? null, normalized.kind, normalized.observedAt,
        normalized.positive ? 1 : 0, normalized.locator ?? null, normalized.artifactRef ?? null, normalized.note ?? null
      );
      this.appendEvent({
        aggregateType: "verification_evidence", aggregateId: normalized.evidenceId, eventType: "verification_evidence.recorded",
        occurredAt: normalized.observedAt, actor,
        payload: { intentId: normalized.intentId, attemptId: normalized.attemptId ?? null, kind: normalized.kind, positive: normalized.positive }
      });
      return normalized;
    });
  }

  listVerificationEvidence(intentId: string, attemptId?: string): readonly VerificationEvidence[] {
    const rows = attemptId
      ? this.db.prepare("SELECT * FROM verification_evidence WHERE intent_id = ? AND attempt_id = ? ORDER BY observed_at, sequence").all(intentId, attemptId) as VerificationEvidenceRow[]
      : this.db.prepare("SELECT * FROM verification_evidence WHERE intent_id = ? ORDER BY observed_at, sequence").all(intentId) as VerificationEvidenceRow[];
    return rows.map(verificationEvidenceFromRow);
  }

  recordVerificationDecision(decision: VerificationDecision, actor: Actor): VerificationDecision {
    return this.transaction(() => {
      if (!this.getIntent(decision.intentId)) throw new VerificationDecisionConflictError(`Unknown publication intent: ${decision.intentId}`);
      if (decision.attemptId) {
        const attempt = this.getPublishAttempt(decision.attemptId);
        if (!attempt || attempt.intentId !== decision.intentId) throw new VerificationDecisionConflictError("Verification decision intent/attempt mismatch");
      }
      for (const evidenceId of decision.evidenceIds) {
        const evidenceRow = this.db.prepare("SELECT * FROM verification_evidence WHERE evidence_id = ?").get(evidenceId) as VerificationEvidenceRow | undefined;
        if (!evidenceRow || evidenceRow.intent_id !== decision.intentId) {
          throw new VerificationDecisionConflictError(`Decision references unknown/mismatched evidence ${evidenceId}`);
        }
      }
      const existingRow = this.db.prepare("SELECT * FROM verification_decisions WHERE decision_id = ?").get(decision.decisionId) as VerificationDecisionRow | undefined;
      if (existingRow) {
        const existing = verificationDecisionFromRow(existingRow);
        if (!sameVerificationDecision(existing, decision)) throw new VerificationDecisionConflictError(`Decision ${decision.decisionId} conflicts with existing record`);
        return existing;
      }
      const normalized: VerificationDecision = { ...decision, decidedAt: asIso(decision.decidedAt) };
      this.db.prepare(`
        INSERT INTO verification_decisions(decision_id, intent_id, attempt_id, decided_at, outcome, policy_name, evidence_ids_json, reason)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        normalized.decisionId, normalized.intentId, normalized.attemptId ?? null, normalized.decidedAt,
        normalized.outcome, normalized.policyName, JSON.stringify([...normalized.evidenceIds]), normalized.reason
      );
      this.appendEvent({
        aggregateType: "verification_decision", aggregateId: normalized.decisionId, eventType: `verification_decision.${normalized.outcome.toLowerCase()}`,
        occurredAt: normalized.decidedAt, actor,
        payload: { intentId: normalized.intentId, attemptId: normalized.attemptId ?? null, evidenceIds: [...normalized.evidenceIds], reason: normalized.reason }
      });
      return normalized;
    });
  }

  listVerificationDecisions(intentId: string): readonly VerificationDecision[] {
    return (this.db.prepare("SELECT * FROM verification_decisions WHERE intent_id = ? ORDER BY decided_at, sequence").all(intentId) as VerificationDecisionRow[])
      .map(verificationDecisionFromRow);
  }

  recordVerifiedPublication(publication: VerifiedPublication, actor: Actor): VerifiedPublication {
    return this.transaction(() => {
      if (!this.getIntent(publication.intentId)) throw new VerifiedPublicationConflictError(`Unknown publication intent: ${publication.intentId}`);
      if (publication.evidenceIds.length === 0) throw new VerifiedPublicationConflictError("Verified publication requires evidence references");
      for (const evidenceId of publication.evidenceIds) {
        const evidenceRow = this.db.prepare("SELECT * FROM verification_evidence WHERE evidence_id = ?").get(evidenceId) as VerificationEvidenceRow | undefined;
        if (!evidenceRow || evidenceRow.intent_id !== publication.intentId) {
          throw new VerifiedPublicationConflictError(`Verified publication references unknown/mismatched evidence ${evidenceId}`);
        }
      }
      const byIntent = this.db.prepare("SELECT * FROM verified_publications WHERE intent_id = ?").get(publication.intentId) as VerifiedPublicationRow | undefined;
      if (byIntent) {
        const existing = verifiedPublicationFromRow(byIntent);
        if (!sameVerifiedPublication(existing, publication)) throw new VerifiedPublicationConflictError(`Intent ${publication.intentId} already has a different verified publication`);
        return existing;
      }
      const byId = this.db.prepare("SELECT * FROM verified_publications WHERE publication_id = ?").get(publication.publicationId) as VerifiedPublicationRow | undefined;
      if (byId) throw new VerifiedPublicationConflictError(`Publication id ${publication.publicationId} already belongs to another intent`);
      const normalized: VerifiedPublication = { ...publication, verifiedAt: asIso(publication.verifiedAt) };
      this.db.prepare(`
        INSERT INTO verified_publications(publication_id, intent_id, verified_at, permalink, evidence_ids_json)
        VALUES (?, ?, ?, ?, ?)
      `).run(normalized.publicationId, normalized.intentId, normalized.verifiedAt, normalized.permalink ?? null, JSON.stringify([...normalized.evidenceIds]));
      this.appendEvent({
        aggregateType: "verified_publication", aggregateId: normalized.publicationId, eventType: "verified_publication.recorded",
        occurredAt: normalized.verifiedAt, actor,
        payload: { intentId: normalized.intentId, permalink: normalized.permalink ?? null, evidenceIds: [...normalized.evidenceIds] }
      });
      return normalized;
    });
  }

  getVerifiedPublication(intentId: string): VerifiedPublication | null {
    const row = this.db.prepare("SELECT * FROM verified_publications WHERE intent_id = ?").get(intentId) as VerifiedPublicationRow | undefined;
    return row ? verifiedPublicationFromRow(row) : null;
  }

  listVerifiedPublications(): readonly VerifiedPublication[] {
    return (this.db.prepare("SELECT * FROM verified_publications ORDER BY verified_at, sequence").all() as VerifiedPublicationRow[])
      .map(verifiedPublicationFromRow);
  }


  createOrRefreshIncident(candidate: IncidentCandidate, actor: Actor): { created: boolean; reopened: boolean; incident: Incident } {
    return this.transaction(() => {
      const existingRow = this.db.prepare("SELECT * FROM incidents WHERE fingerprint = ?").get(candidate.fingerprint) as IncidentRow | undefined;
      const observedAt = asIso(candidate.observedAt);
      if (existingRow) {
        const existing = incidentFromRow(existingRow);
        if (observedAt <= existing.lastObservedAt && existing.status !== "RESOLVED") return { created: false, reopened: false, incident: existing };
        const status: Incident["status"] = existing.status === "RESOLVED" ? "OPEN" : existing.status;
        const count = existing.occurrenceCount + (observedAt > existing.lastObservedAt ? 1 : 0);
        this.db.prepare(`
          UPDATE incidents
          SET kind = ?, severity = ?, title = ?, summary = ?, scope_json = ?, evidence_refs_json = ?, metadata_json = ?,
              status = ?, last_observed_at = ?, occurrence_count = ?,
              acknowledged_at = CASE WHEN ? = 'OPEN' THEN NULL ELSE acknowledged_at END,
              acknowledged_by = CASE WHEN ? = 'OPEN' THEN NULL ELSE acknowledged_by END,
              resolved_at = CASE WHEN ? = 'OPEN' THEN NULL ELSE resolved_at END,
              resolved_by = CASE WHEN ? = 'OPEN' THEN NULL ELSE resolved_by END,
              resolution_note = CASE WHEN ? = 'OPEN' THEN NULL ELSE resolution_note END
          WHERE incident_id = ?
        `).run(
          candidate.kind, candidate.severity, candidate.title, candidate.summary,
          JSON.stringify(candidate.scope), JSON.stringify([...(candidate.evidenceRefs ?? [])]), JSON.stringify(candidate.metadata ?? {}),
          status, observedAt, count, status, status, status, status, status, existing.incidentId
        );
        this.appendEvent({
          aggregateType: "incident", aggregateId: existing.incidentId,
          eventType: existing.status === "RESOLVED" ? "incident.reopened" : "incident.refreshed",
          occurredAt: observedAt, actor,
          payload: { fingerprint: candidate.fingerprint, kind: candidate.kind, occurrenceCount: count }
        });
        return { created: false, reopened: existing.status === "RESOLVED", incident: this.getIncident(existing.incidentId)! };
      }

      const incidentId = newEventId("incident");
      this.db.prepare(`
        INSERT INTO incidents(
          incident_id, fingerprint, kind, severity, title, summary, scope_json, evidence_refs_json, metadata_json,
          status, opened_at, last_observed_at, occurrence_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, 1)
      `).run(
        incidentId, candidate.fingerprint, candidate.kind, candidate.severity, candidate.title, candidate.summary,
        JSON.stringify(candidate.scope), JSON.stringify([...(candidate.evidenceRefs ?? [])]), JSON.stringify(candidate.metadata ?? {}),
        observedAt, observedAt
      );
      this.appendEvent({
        aggregateType: "incident", aggregateId: incidentId, eventType: "incident.opened",
        occurredAt: observedAt, actor,
        payload: { fingerprint: candidate.fingerprint, kind: candidate.kind, severity: candidate.severity }
      });
      return { created: true, reopened: false, incident: this.getIncident(incidentId)! };
    });
  }

  getIncident(incidentId: string): Incident | null {
    const row = this.db.prepare("SELECT * FROM incidents WHERE incident_id = ?").get(incidentId) as IncidentRow | undefined;
    return row ? incidentFromRow(row) : null;
  }

  listIncidents(statuses?: readonly Incident["status"][]): readonly Incident[] {
    if (!statuses || statuses.length === 0) {
      return (this.db.prepare("SELECT * FROM incidents ORDER BY last_observed_at DESC, incident_id").all() as IncidentRow[]).map(incidentFromRow);
    }
    const placeholders = statuses.map(() => "?").join(",");
    return (this.db.prepare(`SELECT * FROM incidents WHERE status IN (${placeholders}) ORDER BY last_observed_at DESC, incident_id`).all(...statuses) as IncidentRow[]).map(incidentFromRow);
  }

  acknowledgeIncident(incidentId: string, at: Instant, operatorId: string, note?: string): Incident {
    return this.transaction(() => {
      const existing = this.getIncident(incidentId);
      if (!existing) throw new IncidentConflictError(`Unknown incident: ${incidentId}`);
      if (existing.status === "RESOLVED") throw new IncidentConflictError(`Incident ${incidentId} is already resolved`);
      if (existing.status === "ACKNOWLEDGED") return existing;
      const timestamp = asIso(at);
      this.db.prepare("UPDATE incidents SET status = 'ACKNOWLEDGED', acknowledged_at = ?, acknowledged_by = ? WHERE incident_id = ?")
        .run(timestamp, operatorId, incidentId);
      this.appendEvent({
        aggregateType: "incident", aggregateId: incidentId, eventType: "incident.acknowledged",
        occurredAt: timestamp, actor: { type: "operator", id: operatorId },
        payload: note ? { note } : {}
      });
      return this.getIncident(incidentId)!;
    });
  }

  resolveIncident(incidentId: string, at: Instant, operatorId: string, note: string): Incident {
    return this.transaction(() => {
      const existing = this.getIncident(incidentId);
      if (!existing) throw new IncidentConflictError(`Unknown incident: ${incidentId}`);
      if (existing.status === "RESOLVED") return existing;
      const timestamp = asIso(at);
      this.db.prepare(`
        UPDATE incidents SET status = 'RESOLVED', resolved_at = ?, resolved_by = ?, resolution_note = ?
        WHERE incident_id = ?
      `).run(timestamp, operatorId, note, incidentId);
      this.appendEvent({
        aggregateType: "incident", aggregateId: incidentId, eventType: "incident.resolved",
        occurredAt: timestamp, actor: { type: "operator", id: operatorId }, payload: { note }
      });
      return this.getIncident(incidentId)!;
    });
  }

  recordHumanAction(action: HumanActionRecord, actor: Actor): HumanActionRecord {
    return this.transaction(() => {
      const existingRow = this.db.prepare("SELECT * FROM human_actions WHERE action_id = ?").get(action.actionId) as HumanActionRow | undefined;
      if (existingRow) {
        const existing = humanActionFromRow(existingRow);
        if (JSON.stringify(existing) !== JSON.stringify(action)) throw new HumanActionConflictError(`Human action ${action.actionId} conflicts with existing record`);
        return existing;
      }
      const normalizedAt = asIso(action.occurredAt);
      this.db.prepare(`
        INSERT INTO human_actions(action_id, kind, occurred_at, operator_id, incident_id, intent_id, note, payload_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        action.actionId, action.kind, normalizedAt, action.operatorId, action.incidentId ?? null, action.intentId ?? null,
        action.note ?? null, JSON.stringify(action.payload)
      );
      this.appendEvent({
        aggregateType: "human_action", aggregateId: action.actionId, eventType: `human_action.${action.kind.toLowerCase()}`,
        occurredAt: normalizedAt, actor,
        payload: { operatorId: action.operatorId, incidentId: action.incidentId ?? null, intentId: action.intentId ?? null }
      });
      const row = this.db.prepare("SELECT * FROM human_actions WHERE action_id = ?").get(action.actionId) as HumanActionRow;
      return humanActionFromRow(row);
    });
  }

  listHumanActions(intentId?: string, incidentId?: string): readonly HumanActionRecord[] {
    const filters: string[] = [];
    const params: string[] = [];
    if (intentId) { filters.push("intent_id = ?"); params.push(intentId); }
    if (incidentId) { filters.push("incident_id = ?"); params.push(incidentId); }
    let sql = "SELECT * FROM human_actions";
    if (filters.length > 0) sql += ` WHERE ${filters.join(" AND ")}`;
    sql += " ORDER BY occurred_at, sequence";
    return (this.db.prepare(sql).all(...params) as HumanActionRow[]).map(humanActionFromRow);
  }

  setKillSwitch(switchState: KillSwitch, actor: Actor): KillSwitch {
    return this.transaction(() => {
      const timestamp = asIso(switchState.updatedAt);
      this.db.prepare(`
        INSERT INTO kill_switches(scope_type, scope_key, enabled, reason, updated_at, updated_by)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope_type, scope_key) DO UPDATE SET
          enabled = excluded.enabled,
          reason = excluded.reason,
          updated_at = excluded.updated_at,
          updated_by = excluded.updated_by
      `).run(switchState.scopeType, switchState.scopeKey, switchState.enabled ? 1 : 0, switchState.reason, timestamp, switchState.updatedBy);
      this.appendEvent({
        aggregateType: "kill_switch", aggregateId: `${switchState.scopeType}:${switchState.scopeKey}`,
        eventType: switchState.enabled ? "kill_switch.enabled" : "kill_switch.disabled",
        occurredAt: timestamp, actor,
        payload: { scopeType: switchState.scopeType, scopeKey: switchState.scopeKey, reason: switchState.reason }
      });
      return this.getKillSwitch(switchState.scopeType, switchState.scopeKey)!;
    });
  }

  getKillSwitch(scopeType: KillSwitchScopeType, scopeKey: string): KillSwitch | null {
    const row = this.db.prepare("SELECT * FROM kill_switches WHERE scope_type = ? AND scope_key = ?").get(scopeType, scopeKey) as KillSwitchRow | undefined;
    return row ? killSwitchFromRow(row) : null;
  }

  listKillSwitches(enabledOnly = false): readonly KillSwitch[] {
    const sql = enabledOnly
      ? "SELECT * FROM kill_switches WHERE enabled = 1 ORDER BY scope_type, scope_key"
      : "SELECT * FROM kill_switches ORDER BY scope_type, scope_key";
    return (this.db.prepare(sql).all() as KillSwitchRow[]).map(killSwitchFromRow);
  }

  enqueueNotification(message: NotificationMessage, channelKeys: readonly string[], actor: Actor): readonly NotificationDelivery[] {
    if (channelKeys.length === 0) return [];
    return this.transaction(() => {
      const existingByDedupe = this.db.prepare("SELECT * FROM notification_messages WHERE dedupe_key = ?").get(message.dedupeKey) as NotificationMessageRow | undefined;
      let notificationId = message.notificationId;
      if (existingByDedupe) {
        notificationId = existingByDedupe.notification_id;
      } else {
        const existingById = this.db.prepare("SELECT * FROM notification_messages WHERE notification_id = ?").get(message.notificationId) as NotificationMessageRow | undefined;
        if (existingById) throw new NotificationConflictError(`Notification id ${message.notificationId} already exists with another dedupe key`);
        const timestamp = asIso(message.createdAt);
        this.db.prepare(`
          INSERT INTO notification_messages(notification_id, dedupe_key, kind, severity, created_at, subject, body, incident_id, intent_id, account_id, metadata_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          message.notificationId, message.dedupeKey, message.kind, message.severity, timestamp, message.subject, message.body,
          message.incidentId ?? null, message.intentId ?? null, message.accountId ?? null, JSON.stringify(message.metadata)
        );
        this.appendEvent({
          aggregateType: "notification", aggregateId: message.notificationId, eventType: "notification.enqueued",
          occurredAt: timestamp, actor, payload: { dedupeKey: message.dedupeKey, kind: message.kind, channels: [...channelKeys] }
        });
      }

      const createdAt = existingByDedupe?.created_at ?? asIso(message.createdAt);
      for (const channelKey of [...new Set(channelKeys)]) {
        this.db.prepare(`
          INSERT OR IGNORE INTO notification_deliveries(notification_id, channel_key, status, attempts, created_at, updated_at)
          VALUES (?, ?, 'PENDING', 0, ?, ?)
        `).run(notificationId, channelKey, createdAt, createdAt);
      }
      return (this.db.prepare("SELECT * FROM notification_deliveries WHERE notification_id = ? ORDER BY channel_key").all(notificationId) as NotificationDeliveryRow[]).map(notificationDeliveryFromRow);
    });
  }

  getNotification(notificationId: string): NotificationMessage | null {
    const row = this.db.prepare("SELECT * FROM notification_messages WHERE notification_id = ?").get(notificationId) as NotificationMessageRow | undefined;
    return row ? notificationMessageFromRow(row) : null;
  }

  listNotificationDeliveries(statuses?: readonly NotificationDelivery["status"][]): readonly NotificationDelivery[] {
    if (!statuses || statuses.length === 0) {
      return (this.db.prepare("SELECT * FROM notification_deliveries ORDER BY created_at, notification_id, channel_key").all() as NotificationDeliveryRow[]).map(notificationDeliveryFromRow);
    }
    const placeholders = statuses.map(() => "?").join(",");
    return (this.db.prepare(`SELECT * FROM notification_deliveries WHERE status IN (${placeholders}) ORDER BY updated_at, notification_id, channel_key`).all(...statuses) as NotificationDeliveryRow[]).map(notificationDeliveryFromRow);
  }

  markNotificationSent(notificationId: string, channelKey: string, at: Instant, receipt: NotificationReceipt, actor: Actor): NotificationDelivery {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM notification_deliveries WHERE notification_id = ? AND channel_key = ?").get(notificationId, channelKey) as NotificationDeliveryRow | undefined;
      if (!row) throw new NotificationConflictError(`Unknown notification delivery ${notificationId}/${channelKey}`);
      if (row.status === "SENT") return notificationDeliveryFromRow(row);
      const timestamp = asIso(at);
      this.db.prepare(`
        UPDATE notification_deliveries SET status = 'SENT', attempts = attempts + 1, updated_at = ?, last_attempt_at = ?, external_message_id = ?, error = NULL
        WHERE notification_id = ? AND channel_key = ?
      `).run(timestamp, timestamp, receipt.externalMessageId ?? null, notificationId, channelKey);
      this.appendEvent({
        aggregateType: "notification", aggregateId: notificationId, eventType: "notification.sent",
        occurredAt: timestamp, actor, payload: { channelKey, externalMessageId: receipt.externalMessageId ?? null }
      });
      const updated = this.db.prepare("SELECT * FROM notification_deliveries WHERE notification_id = ? AND channel_key = ?").get(notificationId, channelKey) as NotificationDeliveryRow;
      return notificationDeliveryFromRow(updated);
    });
  }

  markNotificationFailed(notificationId: string, channelKey: string, at: Instant, error: string, actor: Actor): NotificationDelivery {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM notification_deliveries WHERE notification_id = ? AND channel_key = ?").get(notificationId, channelKey) as NotificationDeliveryRow | undefined;
      if (!row) throw new NotificationConflictError(`Unknown notification delivery ${notificationId}/${channelKey}`);
      if (row.status === "SENT") return notificationDeliveryFromRow(row);
      const timestamp = asIso(at);
      this.db.prepare(`
        UPDATE notification_deliveries SET status = 'FAILED', attempts = attempts + 1, updated_at = ?, last_attempt_at = ?, error = ?
        WHERE notification_id = ? AND channel_key = ?
      `).run(timestamp, timestamp, error, notificationId, channelKey);
      this.appendEvent({
        aggregateType: "notification", aggregateId: notificationId, eventType: "notification.failed",
        occurredAt: timestamp, actor, payload: { channelKey, error }
      });
      const updated = this.db.prepare("SELECT * FROM notification_deliveries WHERE notification_id = ? AND channel_key = ?").get(notificationId, channelKey) as NotificationDeliveryRow;
      return notificationDeliveryFromRow(updated);
    });
  }
  recordEvidenceBundle(bundle: IncidentEvidenceBundle, actor: Actor): IncidentEvidenceBundle {
    return this.transaction(() => {
      if (!this.getIncident(bundle.incidentId)) throw new RepairBundleConflictError(`Unknown incident: ${bundle.incidentId}`);
      const existing = this.db.prepare("SELECT * FROM incident_evidence_bundles WHERE bundle_id = ?").get(bundle.bundleId) as RepairBundleRow | undefined;
      if (existing) {
        const stored = repairBundleFromRow(existing);
        if (JSON.stringify(stored) !== JSON.stringify(bundle)) throw new RepairBundleConflictError(`Bundle ${bundle.bundleId} conflicts with existing record`);
        return stored;
      }
      this.db.prepare(`INSERT INTO incident_evidence_bundles(bundle_id, incident_id, captured_at, release_sha, adapter_version, redaction_policy_version, incident_kind, incident_summary, sanitized_context_json, artifacts_json, redaction_findings_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        bundle.bundleId, bundle.incidentId, asIso(bundle.capturedAt), bundle.releaseSha, bundle.adapterVersion, bundle.redactionPolicyVersion, bundle.incidentKind, bundle.incidentSummary, JSON.stringify(bundle.sanitizedContext), JSON.stringify(bundle.artifacts), JSON.stringify(bundle.redactionFindings)
      );
      this.appendEvent({ aggregateType: "repair_bundle", aggregateId: bundle.bundleId, eventType: "repair_bundle.recorded", occurredAt: bundle.capturedAt, actor, payload: { incidentId: bundle.incidentId, redactionPolicyVersion: bundle.redactionPolicyVersion } });
      return this.getEvidenceBundle(bundle.bundleId)!;
    });
  }

  getEvidenceBundle(bundleId: string): IncidentEvidenceBundle | null {
    const row = this.db.prepare("SELECT * FROM incident_evidence_bundles WHERE bundle_id = ?").get(bundleId) as RepairBundleRow | undefined;
    return row ? repairBundleFromRow(row) : null;
  }

  listEvidenceBundles(incidentId?: string): readonly IncidentEvidenceBundle[] {
    const rows = incidentId
      ? this.db.prepare("SELECT * FROM incident_evidence_bundles WHERE incident_id = ? ORDER BY captured_at, sequence").all(incidentId) as RepairBundleRow[]
      : this.db.prepare("SELECT * FROM incident_evidence_bundles ORDER BY captured_at, sequence").all() as RepairBundleRow[];
    return rows.map(repairBundleFromRow);
  }

  recordAiDiagnosis(diagnosis: AiDiagnosis, actor: Actor): AiDiagnosis {
    return this.transaction(() => {
      const bundle = this.getEvidenceBundle(diagnosis.bundleId);
      if (!bundle || bundle.incidentId !== diagnosis.incidentId) throw new AiDiagnosisConflictError("Diagnosis bundle/incident mismatch");
      const existing = this.db.prepare("SELECT * FROM ai_diagnoses WHERE diagnosis_id = ?").get(diagnosis.diagnosisId) as AiDiagnosisRow | undefined;
      if (existing) { const stored = aiDiagnosisFromRow(existing); if (JSON.stringify(stored) !== JSON.stringify(diagnosis)) throw new AiDiagnosisConflictError(`Diagnosis ${diagnosis.diagnosisId} conflicts`); return stored; }
      this.db.prepare(`INSERT INTO ai_diagnoses(diagnosis_id,bundle_id,incident_id,created_at,classification,confidence,root_cause,evidence_rationale_json,proposed_repair_kind,requires_human,security_notes_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
        diagnosis.diagnosisId, diagnosis.bundleId, diagnosis.incidentId, asIso(diagnosis.createdAt), diagnosis.classification, diagnosis.confidence, diagnosis.rootCause, JSON.stringify(diagnosis.evidenceRationale), diagnosis.proposedRepairKind, diagnosis.requiresHuman ? 1 : 0, JSON.stringify(diagnosis.securityNotes)
      );
      this.appendEvent({ aggregateType: "ai_diagnosis", aggregateId: diagnosis.diagnosisId, eventType: "ai_diagnosis.recorded", occurredAt: diagnosis.createdAt, actor, payload: { incidentId: diagnosis.incidentId, classification: diagnosis.classification, proposedRepairKind: diagnosis.proposedRepairKind } });
      return aiDiagnosisFromRow(this.db.prepare("SELECT * FROM ai_diagnoses WHERE diagnosis_id = ?").get(diagnosis.diagnosisId) as AiDiagnosisRow);
    });
  }

  listAiDiagnoses(incidentId?: string): readonly AiDiagnosis[] {
    const rows = incidentId ? this.db.prepare("SELECT * FROM ai_diagnoses WHERE incident_id = ? ORDER BY created_at, sequence").all(incidentId) as AiDiagnosisRow[] : this.db.prepare("SELECT * FROM ai_diagnoses ORDER BY created_at, sequence").all() as AiDiagnosisRow[];
    return rows.map(aiDiagnosisFromRow);
  }

  recordRepairProposal(proposal: RepairProposal, actor: Actor): RepairProposal {
    return this.transaction(() => {
      const diagnosis = this.db.prepare("SELECT * FROM ai_diagnoses WHERE diagnosis_id = ?").get(proposal.diagnosisId) as AiDiagnosisRow | undefined;
      if (!diagnosis || diagnosis.incident_id !== proposal.incidentId) throw new RepairProposalConflictError("Proposal diagnosis/incident mismatch");
      const existing = this.db.prepare("SELECT * FROM repair_proposals WHERE proposal_id = ?").get(proposal.proposalId) as RepairProposalRow | undefined;
      if (existing) { const stored = repairProposalFromRow(existing); if (JSON.stringify(stored) !== JSON.stringify(proposal)) throw new RepairProposalConflictError(`Proposal ${proposal.proposalId} conflicts`); return stored; }
      this.db.prepare(`INSERT INTO repair_proposals(proposal_id,diagnosis_id,incident_id,created_at,title,summary,unified_diff,changed_files_json,regression_test_files_json,requested_test_commands_json) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
        proposal.proposalId, proposal.diagnosisId, proposal.incidentId, asIso(proposal.createdAt), proposal.title, proposal.summary, proposal.unifiedDiff, JSON.stringify(proposal.changedFiles), JSON.stringify(proposal.regressionTestFiles), JSON.stringify(proposal.requestedTestCommands)
      );
      this.appendEvent({ aggregateType: "repair_proposal", aggregateId: proposal.proposalId, eventType: "repair_proposal.recorded", occurredAt: proposal.createdAt, actor, payload: { incidentId: proposal.incidentId, changedFiles: [...proposal.changedFiles] } });
      return this.getRepairProposal(proposal.proposalId)!;
    });
  }

  getRepairProposal(proposalId: string): RepairProposal | null {
    const row = this.db.prepare("SELECT * FROM repair_proposals WHERE proposal_id = ?").get(proposalId) as RepairProposalRow | undefined;
    return row ? repairProposalFromRow(row) : null;
  }

  listRepairProposals(incidentId?: string): readonly RepairProposal[] {
    const rows = incidentId ? this.db.prepare("SELECT * FROM repair_proposals WHERE incident_id = ? ORDER BY created_at, sequence").all(incidentId) as RepairProposalRow[] : this.db.prepare("SELECT * FROM repair_proposals ORDER BY created_at, sequence").all() as RepairProposalRow[];
    return rows.map(repairProposalFromRow);
  }

  recordRepairGateResult(result: RepairGateResult, actor: Actor): RepairGateResult {
    return this.transaction(() => {
      if (!this.getRepairProposal(result.proposalId)) throw new RepairGateConflictError(`Unknown repair proposal: ${result.proposalId}`);
      const existing = this.db.prepare("SELECT * FROM repair_gate_results WHERE gate_result_id = ?").get(result.gateResultId) as RepairGateRow | undefined;
      if (existing) { const stored = repairGateFromRow(existing); if (JSON.stringify(stored) !== JSON.stringify(result)) throw new RepairGateConflictError(`Gate ${result.gateResultId} conflicts`); return stored; }
      this.db.prepare(`INSERT INTO repair_gate_results(gate_result_id,proposal_id,gate,status,checked_at,summary,artifact_refs_json) VALUES(?,?,?,?,?,?,?)`).run(result.gateResultId, result.proposalId, result.gate, result.status, asIso(result.checkedAt), result.summary, JSON.stringify(result.artifactRefs));
      this.appendEvent({ aggregateType: "repair_gate", aggregateId: result.gateResultId, eventType: `repair_gate.${result.gate.toLowerCase()}.${result.status.toLowerCase()}`, occurredAt: result.checkedAt, actor, payload: { proposalId: result.proposalId, summary: result.summary } });
      return repairGateFromRow(this.db.prepare("SELECT * FROM repair_gate_results WHERE gate_result_id = ?").get(result.gateResultId) as RepairGateRow);
    });
  }

  listRepairGateResults(proposalId: string): readonly RepairGateResult[] {
    return (this.db.prepare("SELECT * FROM repair_gate_results WHERE proposal_id = ? ORDER BY checked_at, sequence").all(proposalId) as RepairGateRow[]).map(repairGateFromRow);
  }

  recordRepairBranch(record: RepairBranchRecord, actor: Actor): RepairBranchRecord {
    return this.transaction(() => {
      if (!this.getRepairProposal(record.proposalId)) throw new RepairBranchConflictError(`Unknown repair proposal: ${record.proposalId}`);
      const byProposal = this.db.prepare("SELECT * FROM repair_branches WHERE proposal_id = ?").get(record.proposalId) as RepairBranchRow | undefined;
      if (byProposal) { const stored = repairBranchFromRow(byProposal); if (JSON.stringify(stored) !== JSON.stringify(record)) throw new RepairBranchConflictError(`Proposal ${record.proposalId} already has another branch record`); return stored; }
      this.db.prepare(`INSERT INTO repair_branches(branch_record_id,proposal_id,created_at,branch_name,base_ref,worktree_path,head_sha) VALUES(?,?,?,?,?,?,?)`).run(record.branchRecordId, record.proposalId, asIso(record.createdAt), record.branchName, record.baseRef, record.worktreePath, record.headSha ?? null);
      this.appendEvent({ aggregateType: "repair_branch", aggregateId: record.branchRecordId, eventType: "repair_branch.recorded", occurredAt: record.createdAt, actor, payload: { proposalId: record.proposalId, branchName: record.branchName, baseRef: record.baseRef } });
      return this.getRepairBranch(record.proposalId)!;
    });
  }

  getRepairBranch(proposalId: string): RepairBranchRecord | null {
    const row = this.db.prepare("SELECT * FROM repair_branches WHERE proposal_id = ?").get(proposalId) as RepairBranchRow | undefined;
    return row ? repairBranchFromRow(row) : null;
  }


}
