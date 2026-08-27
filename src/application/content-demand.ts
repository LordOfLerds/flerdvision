import type { StoredDistributionConfiguration } from "../domain/distribution-ports.js";
import type { ContentAsset, DailyPlan } from "../domain/distribution.js";
import { effectiveRouteCalendar } from "../domain/operating-calendar.js";

export interface RouteContentDemand {
  routeId: string;
  accountId: string;
  requirement: "REQUIRED" | "OPTIONAL";
  slotCount: number;
  schedulePolicyId: string;
  calendarSource: "ROUTE_DEFAULT" | "WEEKDAY" | "DATE_OVERRIDE";
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
  businessDate: string,
  plan?: DailyPlan
): ContentDemandProjection {
  const calendars = Object.fromEntries((stored.operatingCalendars ?? []).map((item)=>[item.calendarId,item]));
  const activeRoutes = stored.config.routes
    .filter((route) => route.enabled)
    .map((route)=>({route,calendar:effectiveRouteCalendar(route,businessDate,calendars)}))
    .filter((entry)=>entry.calendar.active);
  const lanes: LaneContentDemand[] = [];
  const plannedAssetIds = new Set(plan?.businessDate === businessDate ? plan.deliveries.map((delivery) => delivery.assetId) : []);

  for (const lane of stored.config.lanes.filter((item) => item.enabled)) {
    const routes = activeRoutes.filter((entry) => entry.route.laneId === lane.laneId).map((entry): RouteContentDemand => {
      const schedule = stored.schedulePolicies[entry.calendar.schedulePolicyId];
      return {
        routeId: entry.route.routeId,
        accountId: entry.route.accountId,
        requirement: entry.route.requirement,
        slotCount: schedule?.slots.length ?? 0,
        schedulePolicyId: entry.calendar.schedulePolicyId,
        calendarSource: entry.calendar.source
      };
    });
    if (routes.length === 0) continue;

    // Same source asset may fan out to several routes; demand is the maximum source positions
    // required by one route, not the sum of all cross-post deliveries.
    const requiredAssetCount = Math.max(0, ...routes.filter((route) => route.requirement === "REQUIRED").map((route) => route.slotCount));
    const optionalAssetCount = Math.max(0, ...routes.filter((route) => route.requirement === "OPTIONAL").map((route) => route.slotCount));
    const relevantAssets = assets.filter((asset) =>
      asset.laneId === lane.laneId &&
      (asset.scheduledBusinessDate === businessDate || plannedAssetIds.has(asset.assetId))
    );
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
