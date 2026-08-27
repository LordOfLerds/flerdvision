import type { ExecutableRouteTestKey, RouteTestEvidenceRecord, RouteTestExecutionAdapterPort } from "./route-test-ports.js";
import type { RouteTestReadiness } from "./route-test-readiness.js";

export interface RouteTestCommandCapability {
  testKey: ExecutableRouteTestKey;
  executable: boolean;
  reason: string;
}

export interface CapabilityAwareRouteTestExecutionAdapterPort extends RouteTestExecutionAdapterPort {
  capabilities(routeId: string): readonly RouteTestCommandCapability[];
}

export interface RouteTestCommandResult {
  evidence: RouteTestEvidenceRecord;
  readiness: RouteTestReadiness;
}

/** UI-facing command boundary. SECRET_LIVE is intentionally absent from ExecutableRouteTestKey. */
export interface RouteTestCommandPort {
  capabilities(routeId: string): readonly RouteTestCommandCapability[];
  run(routeId: string, testKey: ExecutableRouteTestKey, now: string): Promise<RouteTestCommandResult>;
}
