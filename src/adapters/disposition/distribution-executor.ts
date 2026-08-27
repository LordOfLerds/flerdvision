import type { IngressStorePort } from "../../domain/ingress-ports.js";
import type { SourceDispositionPort } from "../../domain/ports.js";
import type {
  DistributionDispositionExecution,
  DistributionDispositionExecutionResult,
  DistributionDispositionExecutorPort,
  DistributionDispositionMutationKind
} from "../../domain/distribution-disposition-ports.js";
import { SourceAcknowledgementService } from "../../application/ingress-service.js";
import { NoopSourceDispositionAdapter } from "./adapters.js";

export type DistributionDispositionAdapterRegistry = Readonly<Record<string, Partial<Record<Exclude<DistributionDispositionMutationKind,"RECORD_ONLY">, SourceDispositionPort>>>>;

/**
 * RECORD_ONLY is always safe and uses the existing durable source acknowledgement with a no-op
 * external adapter. Every external mutation requires an explicitly registered adapter for both
 * connectionId and mutation kind. No policy is translated into a guessed filesystem/Drive action.
 */
export class ConfiguredDistributionDispositionExecutor implements DistributionDispositionExecutorPort {
  constructor(
    private readonly store: IngressStorePort,
    private readonly adapters: DistributionDispositionAdapterRegistry = {}
  ) {}

  async execute(input: DistributionDispositionExecution): Promise<DistributionDispositionExecutionResult> {
    if(input.mutation==="RECORD_ONLY"){
      await new SourceAcknowledgementService(this.store,new NoopSourceDispositionAdapter())
        .complete(input.sourceObservationId,input.publicationIds,new Date().toISOString());
      return{applied:true,externalMutation:false,manualReview:false,summary:"Completion recorded; source left unchanged."};
    }
    const adapter=this.adapters[input.connection.connectionId]?.[input.mutation];
    if(!adapter){
      return{
        applied:false,
        externalMutation:false,
        manualReview:true,
        summary:`No explicit ${input.mutation} adapter configured for source ${input.connection.connectionId}.`
      };
    }
    await new SourceAcknowledgementService(this.store,adapter)
      .complete(input.sourceObservationId,input.publicationIds,new Date().toISOString());
    return{applied:true,externalMutation:true,manualReview:false,summary:`${input.mutation} applied through explicit source adapter.`};
  }
}
