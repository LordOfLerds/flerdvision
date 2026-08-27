import type { SourceConnection, SourceDispositionPolicy } from "./distribution.js";

export type DistributionDispositionMutationKind = "RECORD_ONLY" | "WRITE_METADATA" | "WRITE_SIDECAR" | "MOVE";

export interface DistributionDispositionExecution {
  mutation: DistributionDispositionMutationKind;
  connection: SourceConnection;
  sourceObservationId: string;
  publicationIds: readonly string[];
  occurredAt: string;
  destinationRef?: string;
  policy: SourceDispositionPolicy;
}

export interface DistributionDispositionExecutionResult {
  applied: boolean;
  externalMutation: boolean;
  manualReview: boolean;
  summary: string;
}

export interface DistributionDispositionExecutorPort {
  execute(input: DistributionDispositionExecution): Promise<DistributionDispositionExecutionResult>;
}
