import type { DistributionConfigurationStorePort, StoredDistributionConfiguration } from "../domain/distribution-ports.js";
import type { CopyProfile, DistributionRoute, PostingProfile, SourceConnection, SourceLane } from "../domain/distribution.js";
import {
  type ConfigurationImpactReport,
  impactOfCopyProfileChange,
  impactOfLaneChange,
  impactOfPostingProfileChange,
  impactOfRouteChange,
  impactOfSourceChange
} from "./distribution-config.js";

export interface ConfigurationMutationResult {
  stored: StoredDistributionConfiguration;
  impact: ConfigurationImpactReport;
}

function upsert<T>(items: readonly T[], match: (item: T) => boolean, value: T): T[] {
  const index = items.findIndex(match);
  if (index < 0) return [...items, value];
  return items.map((item, i) => i === index ? value : item);
}

export class DistributionManagementService {
  constructor(private readonly store: DistributionConfigurationStorePort) {}

  read(): StoredDistributionConfiguration { return this.store.load(); }

  saveSource(source: SourceConnection, expectedRevision: number, now: string): ConfigurationMutationResult {
    const current = this.store.load();
    const impact = impactOfSourceChange(current.config, source.connectionId);
    const config = { ...current.config, sources: upsert(current.config.sources, (item) => item.connectionId === source.connectionId, source) };
    return { stored: this.store.save({ ...current, config, updatedAt: now }, expectedRevision), impact };
  }

  saveLane(lane: SourceLane, expectedRevision: number, now: string): ConfigurationMutationResult {
    const current = this.store.load();
    const impact = impactOfLaneChange(current.config, lane.laneId);
    const config = { ...current.config, lanes: upsert(current.config.lanes, (item) => item.laneId === lane.laneId, lane) };
    return { stored: this.store.save({ ...current, config, updatedAt: now }, expectedRevision), impact };
  }

  savePostingProfile(profile: PostingProfile, expectedRevision: number, now: string): ConfigurationMutationResult {
    const current = this.store.load();
    const impact = impactOfPostingProfileChange(current.config, profile.postingProfileId);
    const config = { ...current.config, postingProfiles: upsert(current.config.postingProfiles, (item) => item.postingProfileId === profile.postingProfileId, profile) };
    return { stored: this.store.save({ ...current, config, updatedAt: now }, expectedRevision), impact };
  }

  saveCopyProfile(profile: CopyProfile, expectedRevision: number, now: string): ConfigurationMutationResult {
    const current = this.store.load();
    const impact = impactOfCopyProfileChange(current.config, profile.copyProfileId);
    const config = { ...current.config, copyProfiles: upsert(current.config.copyProfiles, (item) => item.copyProfileId === profile.copyProfileId, profile) };
    return { stored: this.store.save({ ...current, config, updatedAt: now }, expectedRevision), impact };
  }

  saveRoute(route: DistributionRoute, expectedRevision: number, now: string): ConfigurationMutationResult {
    const current = this.store.load();
    const impact = impactOfRouteChange(current.config, route.routeId);
    const config = { ...current.config, routes: upsert(current.config.routes, (item) => item.routeId === route.routeId, route) };
    return { stored: this.store.save({ ...current, config, updatedAt: now }, expectedRevision), impact };
  }
}
