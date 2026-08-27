import type { RouteTestReadiness } from "../application/control-center-read-model.js";
import type { ContentAsset, DailyPlan } from "./distribution.js";

export interface StoredDailyPlanRevision {
  plan: DailyPlan;
  recordedAt: string;
}

export interface StoredContentAssetRevision {
  asset: ContentAsset;
  version: number;
  recordedAt: string;
}

export interface StoredRouteTestReadinessRevision {
  readiness: RouteTestReadiness;
  version: number;
  recordedAt: string;
}

/** Durable operational state used by runtime and Control Center. */
export interface DistributionRuntimeStateStorePort {
  putDailyPlan(plan: DailyPlan, recordedAt: string): { created: boolean; record: StoredDailyPlanRevision };
  latestDailyPlan(businessDate: string): StoredDailyPlanRevision | null;
  listDailyPlans(businessDate?: string): readonly StoredDailyPlanRevision[];

  putAsset(asset: ContentAsset, recordedAt: string): { created: boolean; record: StoredContentAssetRevision };
  getAsset(assetId: string): StoredContentAssetRevision | null;
  listAssets(): readonly StoredContentAssetRevision[];

  putRouteTestReadiness(readiness: RouteTestReadiness, recordedAt: string): { created: boolean; record: StoredRouteTestReadinessRevision };
  latestRouteTestReadiness(routeId: string): StoredRouteTestReadinessRevision | null;
  listRouteTestReadiness(): readonly StoredRouteTestReadinessRevision[];
}
