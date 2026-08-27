import type { DistributionConfigurationStorePort } from "../domain/distribution-ports.js";
import type { DistributionRuntimeStateStorePort } from "../domain/distribution-runtime-ports.js";
import type { BacklogItem, DailyPlan, PlanningCatalog } from "../domain/distribution.js";
import type { RuntimePlannerPort, RuntimeSourceScanPort } from "../domain/runtime-supervisor-ports.js";
import { DistributionPlanner } from "./distribution-planner.js";
import { DistributionSourceScanCoordinator } from "./distribution-source-scan.js";

function dedupeBacklog(items: readonly BacklogItem[]): BacklogItem[] {
  return [...new Map(items.map((item) => [item.backlogId, item])).values()]
    .sort((a,b)=>a.routeId.localeCompare(b.routeId)||a.assetId.localeCompare(b.assetId)||a.backlogId.localeCompare(b.backlogId));
}

export class RuntimeDistributionSourceScanAdapter implements RuntimeSourceScanPort {
  constructor(private readonly coordinator: DistributionSourceScanCoordinator) {}
  async scan(now: string): Promise<{ observed:number; ready:number; stabilizing:number; blocked:number }> {
    const report = await this.coordinator.run(now);
    return { observed: report.observed, ready: report.ready, stabilizing: report.stabilizing, blocked: report.blocked };
  }
}

export class PersistedDistributionPlannerAdapter implements RuntimePlannerPort {
  constructor(
    private readonly configStore: DistributionConfigurationStorePort,
    private readonly runtime: DistributionRuntimeStateStorePort,
    private readonly planner: DistributionPlanner = new DistributionPlanner()
  ) {}

  async ensureDailyPlan(businessDate: string, now: string): Promise<DailyPlan> {
    const stored = this.configStore.load();
    const catalog: PlanningCatalog = {
      postingProfiles: Object.fromEntries(stored.config.postingProfiles.map((item)=>[item.postingProfileId,item])),
      copyProfiles: Object.fromEntries(stored.config.copyProfiles.map((item)=>[item.copyProfileId,item])),
      schedulePolicies: stored.schedulePolicies
    };
    const carryIn = dedupeBacklog(
      this.runtime.listCurrentDailyPlans()
        .flatMap((record)=>record.plan.backlog)
        .filter((item)=>item.carryToBusinessDate===businessDate)
    );
    const assets = this.runtime.listAssets().map((record)=>record.asset);
    const plan = this.planner.plan({
      businessDate,
      generatedAt: new Date(now).toISOString(),
      assets,
      lanes: stored.config.lanes,
      routes: stored.config.routes,
      catalog,
      policy: stored.planningPolicy,
      ...(carryIn.length>0?{carryInBacklog:carryIn}:{})
    });
    return this.runtime.putDailyPlan(plan,now).record.plan;
  }
}
