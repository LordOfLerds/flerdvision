import type { Instant, Platform, PublicationIntent, UUID } from "./model.js";

export type IncidentKind =
  | "AUTH_REQUIRED"
  | "CHALLENGE"
  | "IDENTITY_MISMATCH"
  | "MISSED_WINDOW"
  | "PUBLISH_UNCERTAIN"
  | "SOURCE_BLOCKED"
  | "PLATFORM_CAPABILITY_MISSING"
  | "BROWSER_UNREACHABLE"
  | "UI_UNKNOWN"
  | "UPLOAD_REJECTED"
  | "POLICY_WARNING"
  | "COPYRIGHT_WARNING"
  | "ACCOUNT_WARNING"
  | "SYSTEM_ERROR";

export type IncidentSeverity = "INFO" | "WARNING" | "ERROR" | "CRITICAL";
export type IncidentStatus = "OPEN" | "ACKNOWLEDGED" | "RESOLVED";

export interface IncidentScope {
  intentId?: UUID;
  accountId?: string;
  browserIdentityId?: string;
  sourceObservationId?: UUID;
  platform?: Platform;
}

export interface IncidentCandidate {
  fingerprint: string;
  kind: IncidentKind;
  severity: IncidentSeverity;
  title: string;
  summary: string;
  observedAt: Instant;
  scope: IncidentScope;
  evidenceRefs?: readonly string[];
  metadata?: Readonly<Record<string, string>>;
}

export interface Incident {
  incidentId: UUID;
  fingerprint: string;
  kind: IncidentKind;
  severity: IncidentSeverity;
  title: string;
  summary: string;
  scope: IncidentScope;
  evidenceRefs: readonly string[];
  metadata: Readonly<Record<string, string>>;
  status: IncidentStatus;
  openedAt: Instant;
  lastObservedAt: Instant;
  occurrenceCount: number;
  acknowledgedAt?: Instant;
  acknowledgedBy?: string;
  resolvedAt?: Instant;
  resolvedBy?: string;
  resolutionNote?: string;
}

export type HumanActionKind =
  | "INCIDENT_ACKNOWLEDGED"
  | "INCIDENT_RESOLVED"
  | "INTENT_RESUMED"
  | "INTENT_WAIVED"
  | "KILL_SWITCH_SET";

export interface HumanActionRecord {
  actionId: UUID;
  kind: HumanActionKind;
  occurredAt: Instant;
  operatorId: string;
  incidentId?: UUID;
  intentId?: UUID;
  note?: string;
  payload: Readonly<Record<string, string>>;
}

export type KillSwitchScopeType = "GLOBAL" | "ACCOUNT" | "PLATFORM";

export interface KillSwitch {
  scopeType: KillSwitchScopeType;
  scopeKey: string;
  enabled: boolean;
  reason: string;
  updatedAt: Instant;
  updatedBy: string;
}

export interface OperationalGateDecision {
  allowed: boolean;
  blockingSwitches: readonly KillSwitch[];
}

export type NotificationKind = "INCIDENT" | "READINESS" | "COMPLETION" | "SYSTEM";
export type NotificationSeverity = "INFO" | "WARNING" | "ERROR" | "CRITICAL";

export interface NotificationMessage {
  notificationId: UUID;
  dedupeKey: string;
  kind: NotificationKind;
  severity: NotificationSeverity;
  createdAt: Instant;
  subject: string;
  body: string;
  incidentId?: UUID;
  intentId?: UUID;
  accountId?: string;
  metadata: Readonly<Record<string, string>>;
}

export type NotificationDeliveryStatus = "PENDING" | "SENT" | "FAILED";

export interface NotificationDelivery {
  notificationId: UUID;
  channelKey: string;
  status: NotificationDeliveryStatus;
  attempts: number;
  createdAt: Instant;
  updatedAt: Instant;
  lastAttemptAt?: Instant;
  externalMessageId?: string;
  error?: string;
}

export interface NotificationReceipt {
  externalMessageId?: string;
}

export interface DailyOperationsItem {
  intentId: string;
  accountId: string;
  creatorId: string;
  platform: PublicationIntent["platform"];
  state: string;
  targetAt?: Instant;
  slotKey?: string;
}

export interface DailyOperationsSummary {
  businessDate: string;
  generatedAt: Instant;
  total: number;
  verified: number;
  waived: number;
  blocked: number;
  uncertain: number;
  scheduledOrActive: number;
  openIncidents: number;
  items: readonly DailyOperationsItem[];
}
