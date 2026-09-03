import type { DistributionConfigurationStorePort } from "../domain/distribution-ports.js";
import type { DistributionRuntimeStateStorePort } from "../domain/distribution-runtime-ports.js";
import type { PlatformSurfaceStorePort } from "../domain/platform-surface-ports.js";
import type { PlannedDelivery } from "../domain/distribution.js";
import type { RouteExecutionQualificationDecision, RouteExecutionQualificationPort } from "../domain/route-execution-ports.js";
import { resolveQualificationReplays } from "./qualification-policy.js";
import { computeSurfaceFingerprint, surfaceFingerprintMatches } from "./surface-fingerprint.js";

export class RouteExecutionQualificationError extends Error {}

export interface RouteExecutionQualificationOptions {
  /** Surface fingerprint the route must have been qualified against; defaults to the running one. */
  surfaceFingerprint?: string;
  /** Required PREPARE_ONLY passes; defaults to the configured replay count. */
  replays?: number;
}

export class PersistedRouteExecutionQualificationGate implements RouteExecutionQualificationPort {
  constructor(
    private readonly config: DistributionConfigurationStorePort,
    private readonly runtime: DistributionRuntimeStateStorePort,
    private readonly surfaces: PlatformSurfaceStorePort,
    private readonly releaseSha: string,
    private readonly options: RouteExecutionQualificationOptions = {}
  ) {
    if (!releaseSha.trim()) throw new Error("Route qualification requires a release SHA");
  }

  /** Fail closed: an unreadable surface fingerprint can never match a recorded one. */
  private currentSurfaceFingerprint(): string | undefined {
    if (this.options.surfaceFingerprint !== undefined) return this.options.surfaceFingerprint;
    try { return computeSurfaceFingerprint(); } catch { return undefined; }
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
    const requiredReplays = this.options.replays ?? resolveQualificationReplays();
    if (!readiness.sourcePassed) reasons.push("source_test_missing");
    if (!readiness.sessionPassed) reasons.push("session_test_missing");
    if (!readiness.identityPassed) reasons.push("identity_test_missing");
    if (readiness.prepareOnlyPasses < requiredReplays) reasons.push("prepare_only_replays_missing");
    if (!readiness.verificationPassed) reasons.push("verification_surface_test_missing");
    // Qualification is bound to the surface code, not to the release SHA: a commit that cannot
    // change what the browser sees must not invalidate a passed route. The release SHA stays
    // recorded for the audit trail and is reported, never blocking on its own.
    if (!surfaceFingerprintMatches(readiness.surfaceFingerprint, this.currentSurfaceFingerprint())) reasons.push("surface_fingerprint_stale");

    const latestSurface = this.surfaces.latestContract(route.accountId, route.postingProfileId);
    if (!latestSurface) reasons.push("surface_contract_missing");
    else {
      if (latestSurface.contract.status !== "CALIBRATED") reasons.push("surface_contract_not_calibrated");
      if (!readiness.surfaceContractId) reasons.push("route_test_surface_contract_missing");
      else if (readiness.surfaceContractId !== latestSurface.contract.contractId) reasons.push("route_test_surface_contract_stale");
    }
    return { allowed: reasons.length === 0, reasons };
  }

  /** Informational: the release the route was qualified on, for evidence and operator reports. */
  qualifiedReleaseSha(routeId: string): { recorded?: string; current: string; matches: boolean } {
    const recorded = this.runtime.latestRouteTestReadiness(routeId)?.readiness.releaseSha;
    return { ...(recorded ? { recorded } : {}), current: this.releaseSha, matches: recorded === this.releaseSha };
  }

  assertAllowed(delivery: PlannedDelivery): void {
    const decision = this.evaluate(delivery);
    if (!decision.allowed) {
      throw new RouteExecutionQualificationError(`Route ${delivery.routeId} is not execution-qualified: ${decision.reasons.join(", ")}`);
    }
  }
}
