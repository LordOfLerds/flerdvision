import type { DistributionConfigurationStorePort } from "../domain/distribution-ports.js";
import { DEFAULT_DISTRIBUTION_RUNTIME_POLICY, decideSourcePoll, type SourcePollingPolicy } from "../domain/distribution-operations.js";

export interface SourcePollingPolicyPreview {
  currentRevision:number;
  current:SourcePollingPolicy;
  next:SourcePollingPolicy;
  invalidateFutureDailyPlans:false;
  requireRouteRetest:false;
  preserveCommittedDeliveries:true;
  operatorSummary:string;
}

function validate(policy:SourcePollingPolicy):SourcePollingPolicy{
  if(!Number.isInteger(policy.activeIntervalMinutes)||policy.activeIntervalMinutes<1)throw new Error("Active source polling interval must be at least 1 minute");
  if(!Number.isInteger(policy.idleIntervalMinutes)||policy.idleIntervalMinutes<1)throw new Error("Idle source polling interval must be at least 1 minute");
  decideSourcePoll({now:"2026-01-15T12:00:00.000Z",policy});
  return policy;
}

export class SourcePollingPolicyManagementService {
  constructor(private readonly store:DistributionConfigurationStorePort){}

  preview(next:SourcePollingPolicy):SourcePollingPolicyPreview{
    const current=this.store.load(),currentPolicy=current.runtimePolicy?.sourcePolling??DEFAULT_DISTRIBUTION_RUNTIME_POLICY.sourcePolling;
    validate(next);
    return{
      currentRevision:current.revision,current:currentPolicy,next,
      invalidateFutureDailyPlans:false,requireRouteRetest:false,preserveCommittedDeliveries:true,
      operatorSummary:`Source polling changes from ${currentPolicy.activeIntervalMinutes}/${currentPolicy.idleIntervalMinutes} min to ${next.activeIntervalMinutes}/${next.idleIntervalMinutes} min. Posting schedules, committed deliveries and route qualification remain unchanged.`
    };
  }

  save(next:SourcePollingPolicy,expectedRevision:number,now:string):SourcePollingPolicyPreview{
    const preview=this.preview(next);
    if(preview.currentRevision!==expectedRevision)throw new Error(`Source polling preview is stale: expected revision ${expectedRevision}, current ${preview.currentRevision}`);
    const current=this.store.load(),runtimePolicy=current.runtimePolicy??DEFAULT_DISTRIBUTION_RUNTIME_POLICY;
    this.store.save({
      updatedAt:new Date(now).toISOString(),
      config:current.config,
      schedulePolicies:current.schedulePolicies,
      planningPolicy:current.planningPolicy,
      ...(current.operatingCalendars?{operatingCalendars:current.operatingCalendars}:{}),
      runtimePolicy:{...runtimePolicy,sourcePolling:next}
    },expectedRevision);
    return preview;
  }
}
