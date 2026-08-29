import type { RuntimeIntentMaterializerPort, RuntimePlannerPort } from "../domain/runtime-supervisor-ports.js";
import type { DailyPlan } from "../domain/distribution.js";
import type { DistributionIntentMaterializationIssue, DistributionIntentMaterializationReport } from "./distribution-intent-materializer.js";
import { DistributionIntentMaterializer, DistributionPlanProvenanceService } from "./distribution-intent-materializer.js";

export interface DistributionMaterializationIssueSinkPort {
  recordIssues(plan: DailyPlan, issues: readonly DistributionIntentMaterializationIssue[], now: string): void;
}

export class ProvenancedRuntimePlannerAdapter implements RuntimePlannerPort {
  constructor(private readonly inner: RuntimePlannerPort, private readonly provenance: DistributionPlanProvenanceService) {}
  async ensureDailyPlan(businessDate: string, now: string): Promise<DailyPlan> {
    const plan = await this.inner.ensureDailyPlan(businessDate, now);
    this.provenance.capture(plan, now);
    return plan;
  }
}

export class RuntimeDistributionIntentMaterializerAdapter implements RuntimeIntentMaterializerPort {
  constructor(private readonly inner: DistributionIntentMaterializer, private readonly issueSink?: DistributionMaterializationIssueSinkPort) {}
  async ensureIntents(plan: DailyPlan, now: string): Promise<{ created: number; existing: number; blocked: number }> {
    const report: DistributionIntentMaterializationReport = this.inner.ensureIntents(plan, now);
    if (report.issues.length > 0) this.issueSink?.recordIssues(plan, report.issues, now);
    // A swallowed reason cost a live acceptance run its diagnosis: "1 blocked" with nothing else
    // said. The phase summary carries the reasons from now on.
    const blockedReasons = [...new Set(report.issues.map((issue) => issue.reason))].slice(0, 3);
    return { created: report.created, existing: report.existing, blocked: report.blocked, ...(blockedReasons.length > 0 ? { blockedReasons } : {}) };
  }
}
