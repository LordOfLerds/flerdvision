import type { Instant } from "./model.js";

export type WorkspaceStatus = "SETUP" | "READY" | "SUSPENDED";

export interface Workspace {
  workspaceId: string;
  displayName: string;
  timezone: string;
  createdAt: Instant;
  status: WorkspaceStatus;
}

export interface WorkspaceRuntimeLayout {
  workspaceRoot: string;
  databasePath: string;
  profilesDir: string;
  evidenceDir: string;
  mediaCacheDir: string;
  configDir: string;
  logsDir: string;
}

export type DeploymentStage = "LUCA_MAC" | "FABIAN_MAC" | "VPS_STAGING" | "VPS_PRODUCTION_READY";
export type QualificationStatus = "ACTIVE" | "PASSED" | "FAILED" | "ABORTED";

export type QualificationGateKind =
  | "INSTALLER"
  | "WORKSPACE_ISOLATION"
  | "CORE_TESTS"
  | "HOST_PREFLIGHT"
  /** Historical W8A gate retained so old persisted runs remain readable. */
  | "SELF_SERVICE_UI"
  /** Historical W8 demo gate retained for persisted compatibility. */
  | "DEMO_DRIVE"
  | "PRODUCT_CONTROL_CENTER"
  | "SOURCE_WORKFLOW"
  | "PROGRAM_ROUTING"
  | "CONTENT_READINESS"
  | "BROWSER_IDENTITY"
  | "ROUTE_QUALIFICATION"
  | "INSTAGRAM_PREPARE"
  | "TIKTOK_PREPARE"
  | "VERIFICATION_CLEANUP"
  | "SECRET_E2E"
  | "NOTIFICATION_FLOW"
  | "INDEPENDENT_USER_ACCEPTANCE"
  | "SERVICE_LIFECYCLE"
  | "FAILURE_CAMPAIGN"
  | "RESTART_PERSISTENCE"
  | "SOAK";

export interface ReleaseQualificationRun {
  runId: string;
  releaseSha: string;
  stage: DeploymentStage;
  workspaceId: string;
  hostFingerprint: string;
  createdAt: Instant;
  createdBy: string;
  status: QualificationStatus;
}

export interface QualificationGateResult {
  gateResultId: string;
  runId: string;
  gate: QualificationGateKind;
  passed: boolean;
  checkedAt: Instant;
  checkedBy: string;
  summary: string;
  artifactRefs: readonly string[];
}

export interface ReleasePromotionState {
  releaseSha: string;
  highestPassedStage: DeploymentStage | null;
  passedStages: readonly DeploymentStage[];
}

const STAGE_ORDER: readonly DeploymentStage[] = ["LUCA_MAC", "FABIAN_MAC", "VPS_STAGING", "VPS_PRODUCTION_READY"];

export function assertWorkspaceId(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{1,47}$/.test(normalized)) throw new Error(`Unsafe workspace id: ${value}`);
  return normalized;
}

export function stagePredecessor(stage: DeploymentStage): DeploymentStage | null {
  const index = STAGE_ORDER.indexOf(stage);
  return index <= 0 ? null : STAGE_ORDER[index - 1]!;
}

const PRODUCT_ACCEPTANCE_GATES: readonly QualificationGateKind[] = [
  "INSTALLER",
  "WORKSPACE_ISOLATION",
  "CORE_TESTS",
  "HOST_PREFLIGHT",
  "PRODUCT_CONTROL_CENTER",
  "SOURCE_WORKFLOW",
  "PROGRAM_ROUTING",
  "CONTENT_READINESS",
  "BROWSER_IDENTITY",
  "ROUTE_QUALIFICATION",
  "INSTAGRAM_PREPARE",
  "TIKTOK_PREPARE",
  "VERIFICATION_CLEANUP",
  "SECRET_E2E",
  "NOTIFICATION_FLOW"
];

export function requiredQualificationGates(stage: DeploymentStage): readonly QualificationGateKind[] {
  if (stage === "LUCA_MAC") return [...PRODUCT_ACCEPTANCE_GATES];
  if (stage === "FABIAN_MAC") return [...PRODUCT_ACCEPTANCE_GATES, "INDEPENDENT_USER_ACCEPTANCE"];
  if (stage === "VPS_STAGING") return [
    ...PRODUCT_ACCEPTANCE_GATES,
    "SERVICE_LIFECYCLE",
    "FAILURE_CAMPAIGN",
    "RESTART_PERSISTENCE",
    "SOAK"
  ];
  return [
    "INSTALLER",
    "WORKSPACE_ISOLATION",
    "CORE_TESTS",
    "HOST_PREFLIGHT",
    "PRODUCT_CONTROL_CENTER",
    "SERVICE_LIFECYCLE",
    "NOTIFICATION_FLOW",
    "FAILURE_CAMPAIGN",
    "RESTART_PERSISTENCE",
    "SOAK"
  ];
}

export function promotionState(releaseSha: string, passedStages: readonly DeploymentStage[]): ReleasePromotionState {
  const ordered = STAGE_ORDER.filter((stage) => passedStages.includes(stage));
  return { releaseSha, highestPassedStage: ordered.length ? ordered[ordered.length - 1]! : null, passedStages: ordered };
}
