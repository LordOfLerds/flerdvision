import type { E2EGateResult } from "./e2e.js";

export type ExecutableRouteTestKey = "SOURCE" | "SESSION" | "IDENTITY" | "SURFACE" | "PREPARE_ONLY" | "VERIFICATION" | "CLEANUP";
export type RouteTestEvidenceKey = ExecutableRouteTestKey | "SECRET_LIVE";
export type RouteTestEvidenceStatus = "PASS" | "FAIL";

export interface RouteTestEvidenceRecord {
  evidenceId: string;
  routeId: string;
  testKey: RouteTestEvidenceKey;
  status: RouteTestEvidenceStatus;
  checkedAt: string;
  /** Kept for the audit trail; readiness is decided by the surface fingerprint below. */
  releaseSha: string;
  /** sha256 of the built surface-driving code this evidence was produced against. */
  surfaceFingerprint?: string;
  surfaceContractId?: string;
  summary: string;
  artifactRefs: readonly string[];
}

export interface RouteTestEvidenceStorePort {
  record(record: RouteTestEvidenceRecord): RouteTestEvidenceRecord;
  list(routeId: string): readonly RouteTestEvidenceRecord[];
}

export interface RouteTestExecutionResult {
  passed:boolean;
  summary:string;
  artifactRefs:readonly string[];
  surfaceContractId?:string;
}

export interface RouteTestExecutionAdapterPort {
  run(routeId: string, testKey: ExecutableRouteTestKey, checkedAt?: string): Promise<RouteTestExecutionResult>;
}

export interface RouteE2EGateBridgePort {
  recordGate(routeId: string, gate: E2EGateResult, releaseSha: string, surfaceContractId?:string, surfaceFingerprint?:string): RouteTestEvidenceRecord | null;
}
