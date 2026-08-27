import type { DistributionConfiguration } from "../application/distribution-config.js";
import type { DistributionPlanningPolicy } from "./distribution.js";
import type { SchedulingPolicy } from "./scheduling.js";

export interface StoredDistributionConfiguration {
  revision: number;
  updatedAt: string;
  config: DistributionConfiguration;
  schedulePolicies: Readonly<Record<string, SchedulingPolicy>>;
  planningPolicy: DistributionPlanningPolicy;
}

export interface DistributionConfigurationStorePort {
  load(): StoredDistributionConfiguration;
  save(next: Omit<StoredDistributionConfiguration, "revision">, expectedRevision: number): StoredDistributionConfiguration;
}
