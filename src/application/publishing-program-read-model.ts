import type { SocialAccount } from "../domain/browser-identity.js";
import type { StoredDistributionConfiguration } from "../domain/distribution-ports.js";
import type { LaneContentDemand } from "./content-demand.js";

export interface PublishingProgramTargetView {
  routeId: string;
  accountId: string;
  accountLabel: string;
  platform: string;
  postingProfileId: string;
  postingProfileLabel: string;
  schedulePolicyId: string;
  rhythm: readonly string[];
  requirement: "REQUIRED" | "OPTIONAL";
  enabled: boolean;
}

export interface PublishingProgramView {
  programId: string;
  laneId: string;
  laneLabel: string;
  sourceConnectionId: string;
  sourceLabel: string;
  folderPath: string;
  creatorId?: string;
  activationMode: string;
  requiredAssetsToday?: number;
  readyAssetsToday?: number;
  contentStatus?: "ENOUGH" | "AT_RISK" | "MISSING";
  targets: readonly PublishingProgramTargetView[];
}

/**
 * UX projection only. DistributionRoute remains the canonical persisted relationship.
 * A PublishingProgram is never saved as a second routing model.
 */
export function projectPublishingPrograms(input: {
  stored: StoredDistributionConfiguration;
  accounts: readonly SocialAccount[];
  demand?: readonly LaneContentDemand[];
}): readonly PublishingProgramView[] {
  const accountMap = new Map(input.accounts.map((account) => [account.accountId, account]));
  const demandMap = new Map((input.demand ?? []).map((item) => [item.laneId, item]));

  return input.stored.config.lanes.map((lane): PublishingProgramView => {
    const source = input.stored.config.sources.find((item) => item.connectionId === lane.connectionId);
    const cursor = input.stored.config.activationCursors.find((item) => item.laneId === lane.laneId);
    const laneDemand = demandMap.get(lane.laneId);
    const targets = input.stored.config.routes
      .filter((route) => route.laneId === lane.laneId)
      .map((route): PublishingProgramTargetView => {
        const account = accountMap.get(route.accountId);
        const profile = input.stored.config.postingProfiles.find((item) => item.postingProfileId === route.postingProfileId);
        const schedule = input.stored.schedulePolicies[route.schedulePolicyId];
        return {
          routeId: route.routeId,
          accountId: route.accountId,
          accountLabel: account ? `@${account.expectedHandle}` : "MISSING ACCOUNT",
          platform: route.platform,
          postingProfileId: route.postingProfileId,
          postingProfileLabel: profile?.displayName ?? "MISSING PROFILE",
          schedulePolicyId: route.schedulePolicyId,
          rhythm: schedule?.slots.map((slot) => slot.localTime) ?? [],
          requirement: route.requirement,
          enabled: route.enabled
        };
      })
      .sort((a, b) => a.platform.localeCompare(b.platform) || a.accountLabel.localeCompare(b.accountLabel) || a.routeId.localeCompare(b.routeId));

    return {
      programId: `program:${lane.laneId}`,
      laneId: lane.laneId,
      laneLabel: lane.displayName,
      sourceConnectionId: lane.connectionId,
      sourceLabel: source?.displayName ?? "MISSING SOURCE",
      folderPath: lane.folderPath,
      ...(lane.creatorId ? { creatorId: lane.creatorId } : {}),
      activationMode: cursor?.mode ?? "MISSING",
      ...(laneDemand ? {
        requiredAssetsToday: laneDemand.requiredAssetCount,
        readyAssetsToday: laneDemand.readyAssetCount,
        contentStatus: laneDemand.status
      } : {}),
      targets
    };
  }).sort((a, b) => a.laneLabel.localeCompare(b.laneLabel) || a.laneId.localeCompare(b.laneId));
}
