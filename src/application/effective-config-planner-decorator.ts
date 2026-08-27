import type { RuntimePlannerPort } from "../domain/runtime-supervisor-ports.js";
import type { DailyPlan } from "../domain/distribution.js";
import type { EffectiveConfigurationChangeService, EffectiveChangeApplyReport } from "./effective-configuration-change.js";

export class EffectiveConfigurationPlannerDecorator implements RuntimePlannerPort {
  private lastApplyReport:EffectiveChangeApplyReport={inspected:0,applied:0,needsReview:0,changeIds:[]};
  constructor(private readonly changes:EffectiveConfigurationChangeService,private readonly inner:RuntimePlannerPort){}

  async ensureDailyPlan(businessDate:string,now:string):Promise<DailyPlan>{
    this.lastApplyReport=this.changes.applyDue(businessDate,now);
    return await this.inner.ensureDailyPlan(businessDate,now);
  }

  latestApplyReport():EffectiveChangeApplyReport{return this.lastApplyReport;}
}
