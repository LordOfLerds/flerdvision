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
  releaseSha: string;
  summary: string;
  artifactRefs: readonly string[];
}

export interface RouteTestEvidenceStorePort {
  record(record: RouteTestEvidenceRecord): RouteTestEvidenceRecord;
  list(routeId: string): readonly RouteTestEvidenceRecord[];
}

export interface RouteTestExecutionAdapterPort {
  run(routeId: string, testKey: ExecutableRouteTestKey): Promise<{ passed: boolean; summary: string; artifactRefs: readonly string[] }>;
}

export interface RouteE2EGateBridgePort {
  recordGate(routeId: string, gate: E2EGateResult, releaseSha: string): RouteTestEvidenceRecord | null;
}
