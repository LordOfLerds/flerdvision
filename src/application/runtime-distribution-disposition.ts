import type { DistributionConfigurationStorePort } from "../domain/distribution-ports.js";
import type { DistributionDispositionExecutorPort } from "../domain/distribution-disposition-ports.js";
import type { DistributionRuntimeStateStorePort } from "../domain/distribution-runtime-ports.js";
import type { RuntimeDispositionPort } from "../domain/runtime-supervisor-ports.js";
import { DistributionDeliveryAggregateProjector } from "./distribution-delivery-aggregate.js";
import { dispositionForConnection } from "./source-disposition-coordinator.js";

export class RuntimeDistributionDispositionAdapter implements RuntimeDispositionPort {
  constructor(
    private readonly config: DistributionConfigurationStorePort,
    private readonly runtime: DistributionRuntimeStateStorePort,
    private readonly aggregates: DistributionDeliveryAggregateProjector,
    private readonly executor: DistributionDispositionExecutorPort
  ) {}

  async applyEligible(now: string): Promise<{ inspected:number; completed:number; externalMutations:number; manualReview:number }> {
    const stored = this.config.load();
    let inspected=0,completed=0,externalMutations=0,manualReview=0;
    for (const projected of this.aggregates.project()) {
      inspected+=1;
      const assetRecord=this.runtime.getAsset(projected.aggregate.assetId);
      if(!assetRecord) { manualReview+=1; continue; }
      if(assetRecord.asset.state==="COMPLETE") continue;
      if(assetRecord.asset.state==="BLOCKED") { manualReview+=1; continue; }
      const lane=stored.config.lanes.find((item)=>item.laneId===assetRecord.asset.laneId);
      const connection=lane?stored.config.sources.find((item)=>item.connectionId===lane.connectionId):undefined;
      if(!lane||!connection){manualReview+=1;continue;}
      const decision=dispositionForConnection(projected.aggregate,connection);
      if(decision.action==="NOOP") continue;
      if(decision.action==="MANUAL_REVIEW"){manualReview+=1;continue;}
      const result=await this.executor.execute({
        mutation:decision.action,
        connection,
        sourceObservationId:assetRecord.asset.sourceObservationId,
        publicationIds:projected.publicationIds,
        policy:connection.disposition,
        ...(decision.action==="MOVE"?{destinationRef:decision.destinationRef}:{})
      });
      if(result.manualReview||!result.applied){manualReview+=1;continue;}
      if(result.externalMutation)externalMutations+=1;
      this.runtime.putAsset({...assetRecord.asset,state:"COMPLETE",metadata:{...assetRecord.asset.metadata,completedAt:new Date(now).toISOString(),sourceDisposition:decision.action}},now);
      completed+=1;
    }
    return{inspected,completed,externalMutations,manualReview};
  }
}
