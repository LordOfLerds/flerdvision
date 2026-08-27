import type { StoredDistributionConfiguration } from "../domain/distribution-ports.js";
import type { ContentAsset } from "../domain/distribution.js";

export interface RouteContentDemand {
  routeId: string;
  accountId: string;
  requirement: "REQUIRED" | "OPTIONAL";
  slotCount: number;
}

export interface LaneContentDemand {
  laneId: string;
  businessDate: string;
  requiredAssetCount: number;
  optionalAssetCount: number;
  readyAssetCount: number;
  stabilizingAssetCount: number;
  blockedAssetCount: number;
  missingRequiredAssetCount: number;
  potentiallyReadyAssetCount: number;
  status: "ENOUGH" | "AT_RISK" | "MISSING";
  routes: readonly RouteContentDemand[];
}

export interface ContentDemandProjection {
  businessDate: string;
  lanes: readonly LaneContentDemand[];
  missingRequiredAssets: number;
  atRiskLanes: number;
}

export function projectContentDemand(
  stored: StoredDistributionConfiguration,
  assets: readonly ContentAsset[],
  businessDate: string
): ContentDemandProjection {
  const activeRoutes = stored.config.routes.filter((route) => route.enabled);
  const lanes: LaneContentDemand[] = [];

  for (const lane of stored.config.lanes.filter((item) => item.enabled)) {
    const routes = activeRoutes.filter((route) => route.laneId === lane.laneId).map((route): RouteContentDemand => {
      const schedule = stored.schedulePolicies[route.schedulePolicyId];
      return {
        routeId: route.routeId,
        accountId: route.accountId,
        requirement: route.requirement,
        slotCount: schedule?.slots.length ?? 0
      };
    });
    if (routes.length === 0) continue;

    // The same source asset may fan out to several routes. Therefore source demand is the maximum
    // number of source positions required by a route, never the sum of all cross-post deliveries.
    const requiredAssetCount = Math.max(0, ...routes.filter((route) => route.requirement === "REQUIRED").map((route) => route.slotCount));
    const optionalAssetCount = Math.max(0, ...routes.filter((route) => route.requirement === "OPTIONAL").map((route) => route.slotCount));
    const relevantAssets = assets.filter((asset) => asset.laneId === lane.laneId && asset.scheduledBusinessDate === businessDate);
    const readyAssetCount = relevantAssets.filter((asset) => asset.state === "READY" || asset.state === "COMPLETE").length;
    const stabilizingAssetCount = relevantAssets.filter((asset) => asset.state === "OBSERVED" || asset.state === "STABILIZING").length;
    const blockedAssetCount = relevantAssets.filter((asset) => asset.state === "BLOCKED").length;
    const missingRequiredAssetCount = Math.max(0, requiredAssetCount - readyAssetCount);
    const potentiallyReadyAssetCount = readyAssetCount + stabilizingAssetCount;
    const status: LaneContentDemand["status"] = missingRequiredAssetCount === 0
      ? "ENOUGH"
      : potentiallyReadyAssetCount >= requiredAssetCount
        ? "AT_RISK"
        : "MISSING";

    lanes.push({
      laneId: lane.laneId,
      businessDate,
      requiredAssetCount,
      optionalAssetCount,
      readyAssetCount,
      stabilizingAssetCount,
      blockedAssetCount,
      missingRequiredAssetCount,
      potentiallyReadyAssetCount,
      status,
      routes
    });
  }

  return {
    businessDate,
    lanes: lanes.sort((a, b) => a.laneId.localeCompare(b.laneId)),
    missingRequiredAssets: lanes.reduce((sum, lane) => sum + lane.missingRequiredAssetCount, 0),
    atRiskLanes: lanes.filter((lane) => lane.status === "AT_RISK").length
  };
}
