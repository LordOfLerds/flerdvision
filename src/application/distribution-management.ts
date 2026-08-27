import type { DistributionConfigurationStorePort, StoredDistributionConfiguration } from "../domain/distribution-ports.js";
import type { CopyProfile, DistributionRoute, PostingProfile, SourceActivationCursor, SourceConnection, SourceLane } from "../domain/distribution.js";
import {
  assertConfigurationReferentialIntegrity,
  type ConfigurationImpactReport,
  type DistributionConfiguration,
  impactOfActivationCursorChange,
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

export interface ConfigurationMutationPreview {
  currentRevision: number;
  nextConfig: DistributionConfiguration;
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

  previewSource(source: SourceConnection): ConfigurationMutationPreview {
    const current = this.store.load();
    const nextConfig = { ...current.config, sources: upsert(current.config.sources, (item) => item.connectionId === source.connectionId, source) };
    assertConfigurationReferentialIntegrity(nextConfig);
    return { currentRevision: current.revision, nextConfig, impact: impactOfSourceChange(current.config, source.connectionId) };
  }

  saveSource(source: SourceConnection, expectedRevision: number, now: string): ConfigurationMutationResult {
    const preview = this.previewSource(source);
    const current = this.store.load();
    return { stored: this.store.save({ ...current, config: preview.nextConfig, updatedAt: now }, expectedRevision), impact: preview.impact };
  }

  previewLane(lane: SourceLane): ConfigurationMutationPreview {
    const current = this.store.load();
    const nextConfig = { ...current.config, lanes: upsert(current.config.lanes, (item) => item.laneId === lane.laneId, lane) };
    assertConfigurationReferentialIntegrity(nextConfig);
    return { currentRevision: current.revision, nextConfig, impact: impactOfLaneChange(current.config, lane.laneId) };
  }

  saveLane(lane: SourceLane, expectedRevision: number, now: string): ConfigurationMutationResult {
    const preview = this.previewLane(lane);
    const current = this.store.load();
    return { stored: this.store.save({ ...current, config: preview.nextConfig, updatedAt: now }, expectedRevision), impact: preview.impact };
  }

  previewPostingProfile(profile: PostingProfile): ConfigurationMutationPreview {
    const current = this.store.load();
    const nextConfig = { ...current.config, postingProfiles: upsert(current.config.postingProfiles, (item) => item.postingProfileId === profile.postingProfileId, profile) };
    assertConfigurationReferentialIntegrity(nextConfig);
    return { currentRevision: current.revision, nextConfig, impact: impactOfPostingProfileChange(current.config, profile.postingProfileId) };
  }

  savePostingProfile(profile: PostingProfile, expectedRevision: number, now: string): ConfigurationMutationResult {
    const preview = this.previewPostingProfile(profile);
    const current = this.store.load();
    return { stored: this.store.save({ ...current, config: preview.nextConfig, updatedAt: now }, expectedRevision), impact: preview.impact };
  }

  previewCopyProfile(profile: CopyProfile): ConfigurationMutationPreview {
    const current = this.store.load();
    const nextConfig = { ...current.config, copyProfiles: upsert(current.config.copyProfiles, (item) => item.copyProfileId === profile.copyProfileId, profile) };
    assertConfigurationReferentialIntegrity(nextConfig);
    return { currentRevision: current.revision, nextConfig, impact: impactOfCopyProfileChange(current.config, profile.copyProfileId) };
  }

  saveCopyProfile(profile: CopyProfile, expectedRevision: number, now: string): ConfigurationMutationResult {
    const preview = this.previewCopyProfile(profile);
    const current = this.store.load();
    return { stored: this.store.save({ ...current, config: preview.nextConfig, updatedAt: now }, expectedRevision), impact: preview.impact };
  }

  previewActivationCursor(cursor: SourceActivationCursor): ConfigurationMutationPreview {
    const current = this.store.load();
    const nextConfig = { ...current.config, activationCursors: upsert(current.config.activationCursors, (item) => item.laneId === cursor.laneId, cursor) };
    assertConfigurationReferentialIntegrity(nextConfig);
    return { currentRevision: current.revision, nextConfig, impact: impactOfActivationCursorChange(current.config, cursor.laneId) };
  }

  saveActivationCursor(cursor: SourceActivationCursor, expectedRevision: number, now: string): ConfigurationMutationResult {
    const preview = this.previewActivationCursor(cursor);
    const current = this.store.load();
    return { stored: this.store.save({ ...current, config: preview.nextConfig, updatedAt: now }, expectedRevision), impact: preview.impact };
  }

  previewRoute(route: DistributionRoute): ConfigurationMutationPreview {
    const current = this.store.load();
    const nextConfig = { ...current.config, routes: upsert(current.config.routes, (item) => item.routeId === route.routeId, route) };
    assertConfigurationReferentialIntegrity(nextConfig);
    return { currentRevision: current.revision, nextConfig, impact: impactOfRouteChange(current.config, route.routeId) };
  }

  saveRoute(route: DistributionRoute, expectedRevision: number, now: string): ConfigurationMutationResult {
    const preview = this.previewRoute(route);
    const current = this.store.load();
    return { stored: this.store.save({ ...current, config: preview.nextConfig, updatedAt: now }, expectedRevision), impact: preview.impact };
  }
}
