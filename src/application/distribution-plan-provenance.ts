import { createHash } from "node:crypto";
import type { StoredDistributionConfiguration } from "../domain/distribution-ports.js";
import type { DailyPlan, DistributionRoute } from "../domain/distribution.js";
import type { DailyPlanProvenance, RoutePlanningSnapshot } from "../domain/distribution-provenance.js";

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function routePlanningFingerprint(snapshot: Omit<RoutePlanningSnapshot, "fingerprint">): string {
  return createHash("sha256").update(stable(snapshot)).digest("hex");
}

export function routePlanningSnapshot(stored: StoredDistributionConfiguration, route: DistributionRoute): RoutePlanningSnapshot {
  const lane = stored.config.lanes.find((item) => item.laneId === route.laneId);
  if (!lane || !lane.enabled) throw new Error(`Route ${route.routeId} lane is missing or disabled`);
  const source = stored.config.sources.find((item) => item.connectionId === lane.connectionId);
  if (!source || !source.enabled) throw new Error(`Route ${route.routeId} source is missing or disabled`);
  const postingProfile = stored.config.postingProfiles.find((item) => item.postingProfileId === route.postingProfileId);
  if (!postingProfile || !postingProfile.enabled) throw new Error(`Route ${route.routeId} posting profile is missing or disabled`);
  if (postingProfile.platform !== route.platform) throw new Error(`Route ${route.routeId} platform/profile mismatch`);
  const copyProfile = stored.config.copyProfiles.find((item) => item.copyProfileId === route.copyProfileId);
  if (!copyProfile || !copyProfile.enabled) throw new Error(`Route ${route.routeId} copy profile is missing or disabled`);
  const schedulePolicy = stored.schedulePolicies[route.schedulePolicyId];
  if (!schedulePolicy) throw new Error(`Route ${route.routeId} schedule policy is missing`);
  const activationCursor = stored.config.activationCursors.find((item) => item.laneId === lane.laneId);
  if (!activationCursor) throw new Error(`Route ${route.routeId} lane has no activation cursor`);
  const base = { routeId: route.routeId, source, lane, activationCursor, route, postingProfile, copyProfile, schedulePolicy, planningPolicy: stored.planningPolicy };
  return { ...base, fingerprint: routePlanningFingerprint(base) };
}

export function captureDailyPlanProvenance(plan: DailyPlan, stored: StoredDistributionConfiguration, capturedAt: string): DailyPlanProvenance {
  const routeIds = [...new Set([
    ...plan.deliveries.map((item) => item.routeId),
    ...plan.gaps.map((item) => item.routeId).filter((item): item is string => Boolean(item)),
    ...plan.backlog.map((item) => item.routeId)
  ])].sort();
  const routeSnapshots: Record<string, RoutePlanningSnapshot> = {};
  for (const routeId of routeIds) {
    const route = stored.config.routes.find((item) => item.routeId === routeId);
    if (!route) throw new Error(`DailyPlan ${plan.planId} references missing route ${routeId}`);
    routeSnapshots[routeId] = routePlanningSnapshot(stored, route);
  }
  return { planId: plan.planId, businessDate: plan.businessDate, capturedAt: new Date(capturedAt).toISOString(), routeSnapshots };
}

export function assertPlanRouteStillCurrent(provenance: DailyPlanProvenance, routeId: string, current: StoredDistributionConfiguration): RoutePlanningSnapshot {
  const planned = provenance.routeSnapshots[routeId];
  if (!planned) throw new Error(`Plan ${provenance.planId} has no route snapshot for ${routeId}`);
  const route = current.config.routes.find((item) => item.routeId === routeId);
  if (!route) throw new Error(`Route ${routeId} no longer exists; planned delivery is stale`);
  const currentSnapshot = routePlanningSnapshot(current, route);
  if (currentSnapshot.fingerprint !== planned.fingerprint) throw new Error(`Route ${routeId} configuration changed after DailyPlan ${provenance.planId}; regenerate plan before materializing intents`);
  return planned;
}
