import type { ContentAsset, DailyPlan } from "./distribution.js";
import type { RouteTestReadiness } from "./route-test-readiness.js";

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
  /** Append-only audit history; never use this to decide current carry-over/disposition. */
  listDailyPlans(businessDate?: string): readonly StoredDailyPlanRevision[];
  /** Exactly the currently selected plan head for each business date. */
  listCurrentDailyPlans(): readonly StoredDailyPlanRevision[];

  putAsset(asset: ContentAsset, recordedAt: string): { created: boolean; record: StoredContentAssetRevision };
  getAsset(assetId: string): StoredContentAssetRevision | null;
  listAssets(): readonly StoredContentAssetRevision[];

  putRouteTestReadiness(readiness: RouteTestReadiness, recordedAt: string): { created: boolean; record: StoredRouteTestReadinessRevision };
  latestRouteTestReadiness(routeId: string): StoredRouteTestReadinessRevision | null;
  listRouteTestReadiness(): readonly StoredRouteTestReadinessRevision[];
}
