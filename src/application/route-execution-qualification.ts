import type { DistributionConfigurationStorePort } from "../domain/distribution-ports.js";
import type { DistributionRuntimeStateStorePort } from "../domain/distribution-runtime-ports.js";
import type { PlatformSurfaceStorePort } from "../domain/platform-surface-ports.js";
import type { PlannedDelivery } from "../domain/distribution.js";
import type { RouteExecutionQualificationDecision, RouteExecutionQualificationPort } from "../domain/route-execution-ports.js";

export class RouteExecutionQualificationError extends Error {}

export class PersistedRouteExecutionQualificationGate implements RouteExecutionQualificationPort {
  constructor(
    private readonly config: DistributionConfigurationStorePort,
    private readonly runtime: DistributionRuntimeStateStorePort,
    private readonly surfaces: PlatformSurfaceStorePort,
    private readonly releaseSha: string
  ) {
    if (!releaseSha.trim()) throw new Error("Route qualification requires a release SHA");
  }

  evaluate(delivery: PlannedDelivery): RouteExecutionQualificationDecision {
    const reasons: string[] = [];
    const stored = this.config.load();
    const route = stored.config.routes.find((item) => item.routeId === delivery.routeId);
    if (!route || !route.enabled) return { allowed: false, reasons: ["route_missing_or_disabled"] };
    if (route.accountId !== delivery.accountId) reasons.push("delivery_account_differs_from_route");
    if (route.postingProfileId !== delivery.postingProfileId) reasons.push("delivery_profile_differs_from_route");

    const readiness = this.runtime.latestRouteTestReadiness(route.routeId)?.readiness;
    if (!readiness) return { allowed: false, reasons: [...reasons, "route_test_readiness_missing"] };
    if (!readiness.sourcePassed) reasons.push("source_test_missing");
    if (!readiness.sessionPassed) reasons.push("session_test_missing");
    if (!readiness.identityPassed) reasons.push("identity_test_missing");
    if (readiness.prepareOnlyPasses < 3) reasons.push("prepare_only_replays_lt_3");
    if (!readiness.verificationPassed) reasons.push("verification_surface_test_missing");
    if (readiness.releaseSha !== this.releaseSha) reasons.push("route_test_release_sha_stale_or_missing");

    const latestSurface = this.surfaces.latestContract(route.accountId, route.postingProfileId);
    if (!latestSurface) reasons.push("surface_contract_missing");
    else {
      if (latestSurface.contract.status !== "CALIBRATED") reasons.push("surface_contract_not_calibrated");
      if (!readiness.surfaceContractId) reasons.push("route_test_surface_contract_missing");
      else if (readiness.surfaceContractId !== latestSurface.contract.contractId) reasons.push("route_test_surface_contract_stale");
    }
    return { allowed: reasons.length === 0, reasons };
  }

  assertAllowed(delivery: PlannedDelivery): void {
    const decision = this.evaluate(delivery);
    if (!decision.allowed) {
      throw new RouteExecutionQualificationError(`Route ${delivery.routeId} is not execution-qualified: ${decision.reasons.join(", ")}`);
    }
  }
}
