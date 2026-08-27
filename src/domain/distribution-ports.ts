import type { DistributionConfiguration } from "../application/distribution-config.js";
import type { DistributionPlanningPolicy } from "./distribution.js";
import type { DistributionRuntimePolicy } from "./distribution-operations.js";
import type { SchedulingPolicy } from "./scheduling.js";

export interface StoredDistributionConfiguration {
  revision: number;
  updatedAt: string;
  config: DistributionConfiguration;
  schedulePolicies: Readonly<Record<string, SchedulingPolicy>>;
  planningPolicy: DistributionPlanningPolicy;
  /** Optional for backward compatibility; stores normalize missing values to the safe default. */
  runtimePolicy?: DistributionRuntimePolicy;
}

export interface DistributionConfigurationStorePort {
  load(): StoredDistributionConfiguration;
  save(next: Omit<StoredDistributionConfiguration, "revision">, expectedRevision: number): StoredDistributionConfiguration;
}
