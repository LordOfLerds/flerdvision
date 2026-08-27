import type {
  CopyProfile,
  DistributionRoute,
  PostingProfile,
  SourceConnection,
  SourceLane
} from "../domain/distribution.js";

export interface DistributionConfiguration {
  sources: readonly SourceConnection[];
  lanes: readonly SourceLane[];
  postingProfiles: readonly PostingProfile[];
  copyProfiles: readonly CopyProfile[];
  routes: readonly DistributionRoute[];
}

export type ConfigurationChangeKind =
  | "SOURCE_CHANGED"
  | "LANE_CHANGED"
  | "POSTING_PROFILE_CHANGED"
  | "COPY_PROFILE_CHANGED"
  | "ROUTE_CHANGED";

export interface ConfigurationImpactReport {
  changeKind: ConfigurationChangeKind;
  changedId: string;
  affectedRouteIds: readonly string[];
  invalidateFutureDailyPlans: boolean;
  requireRouteRetest: boolean;
  requireActivationCursor: boolean;
  preserveVerifiedPublications: true;
  preserveHistoricalAudit: true;
  operatorSummary: string;
}

function routeIds(routes: readonly DistributionRoute[]): string[] {
  return [...new Set(routes.map((route) => route.routeId))].sort();
}

export function impactOfSourceChange(config: DistributionConfiguration, connectionId: string): ConfigurationImpactReport {
  const laneIds = new Set(config.lanes.filter((lane) => lane.connectionId === connectionId).map((lane) => lane.laneId));
  const affected = routeIds(config.routes.filter((route) => laneIds.has(route.laneId)));
  return {
    changeKind: "SOURCE_CHANGED",
    changedId: connectionId,
    affectedRouteIds: affected,
    invalidateFutureDailyPlans: affected.length > 0,
    requireRouteRetest: true,
    requireActivationCursor: true,
    preserveVerifiedPublications: true,
    preserveHistoricalAudit: true,
    operatorSummary: affected.length > 0
      ? `${affected.length} route(s) depend on this source. Reconnect/retest source and establish a new activation boundary before planning new files.`
      : "No route currently depends on this source."
  };
}

export function impactOfLaneChange(config: DistributionConfiguration, laneId: string): ConfigurationImpactReport {
  const affected = routeIds(config.routes.filter((route) => route.laneId === laneId));
  return {
    changeKind: "LANE_CHANGED",
    changedId: laneId,
    affectedRouteIds: affected,
    invalidateFutureDailyPlans: affected.length > 0,
    requireRouteRetest: true,
    requireActivationCursor: true,
    preserveVerifiedPublications: true,
    preserveHistoricalAudit: true,
    operatorSummary: affected.length > 0
      ? `${affected.length} route(s) use this lane. Future plans are stale until the lane is re-activated and route tests pass.`
      : "No route currently uses this lane."
  };
}

export function impactOfPostingProfileChange(config: DistributionConfiguration, postingProfileId: string): ConfigurationImpactReport {
  const affected = routeIds(config.routes.filter((route) => route.postingProfileId === postingProfileId));
  return {
    changeKind: "POSTING_PROFILE_CHANGED",
    changedId: postingProfileId,
    affectedRouteIds: affected,
    invalidateFutureDailyPlans: affected.length > 0,
    requireRouteRetest: affected.length > 0,
    requireActivationCursor: false,
    preserveVerifiedPublications: true,
    preserveHistoricalAudit: true,
    operatorSummary: affected.length > 0
      ? `${affected.length} route(s) inherit this posting behaviour. Their future plans and prepare-only qualification must be refreshed.`
      : "No route currently uses this posting profile."
  };
}

export function impactOfCopyProfileChange(config: DistributionConfiguration, copyProfileId: string): ConfigurationImpactReport {
  const affected = routeIds(config.routes.filter((route) => route.copyProfileId === copyProfileId));
  return {
    changeKind: "COPY_PROFILE_CHANGED",
    changedId: copyProfileId,
    affectedRouteIds: affected,
    invalidateFutureDailyPlans: affected.length > 0,
    requireRouteRetest: false,
    requireActivationCursor: false,
    preserveVerifiedPublications: true,
    preserveHistoricalAudit: true,
    operatorSummary: affected.length > 0
      ? `${affected.length} route(s) use this copy profile. Future intents need a new copyVersionId; published history remains immutable.`
      : "No route currently uses this copy profile."
  };
}

export function impactOfRouteChange(config: DistributionConfiguration, routeId: string): ConfigurationImpactReport {
  const exists = config.routes.some((route) => route.routeId === routeId);
  return {
    changeKind: "ROUTE_CHANGED",
    changedId: routeId,
    affectedRouteIds: exists ? [routeId] : [],
    invalidateFutureDailyPlans: exists,
    requireRouteRetest: exists,
    requireActivationCursor: false,
    preserveVerifiedPublications: true,
    preserveHistoricalAudit: true,
    operatorSummary: exists
      ? "Route change affects future planning and route qualification only; existing verified publications and audit history remain untouched."
      : "Route does not exist in the current configuration."
  };
}

export function assertConfigurationReferentialIntegrity(config: DistributionConfiguration): void {
  const sourceIds = new Set(config.sources.map((source) => source.connectionId));
  const laneIds = new Set(config.lanes.map((lane) => lane.laneId));
  const postingIds = new Set(config.postingProfiles.map((profile) => profile.postingProfileId));
  const copyIds = new Set(config.copyProfiles.map((profile) => profile.copyProfileId));

  for (const lane of config.lanes) {
    if (!sourceIds.has(lane.connectionId)) throw new Error(`Lane ${lane.laneId} references missing source ${lane.connectionId}`);
  }
  for (const route of config.routes) {
    if (!laneIds.has(route.laneId)) throw new Error(`Route ${route.routeId} references missing lane ${route.laneId}`);
    if (!postingIds.has(route.postingProfileId)) throw new Error(`Route ${route.routeId} references missing posting profile ${route.postingProfileId}`);
    if (!copyIds.has(route.copyProfileId)) throw new Error(`Route ${route.routeId} references missing copy profile ${route.copyProfileId}`);
  }
}
