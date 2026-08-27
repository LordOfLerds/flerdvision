import { createHash } from "node:crypto";
import type { SocialAccount } from "../domain/browser-identity.js";
import type { DistributionConfigurationStorePort, StoredDistributionConfiguration } from "../domain/distribution-ports.js";
import type { DeliveryRequirement, DistributionRoute } from "../domain/distribution.js";
import { effectiveRouteCalendar } from "../domain/operating-calendar.js";
import { assertConfigurationReferentialIntegrity } from "./distribution-config.js";

export interface PublishingProgramTargetDraft {
  routeId?: string;
  accountId: string;
  postingProfileId: string;
  copyProfileId: string;
  schedulePolicyId: string;
  operatingCalendarId?: string;
  requirement: DeliveryRequirement;
  enabled?: boolean;
}

export interface PublishingProgramDraft {
  laneId: string;
  /** Date used only for impact/rhythm preview; saved routes stay reusable. */
  businessDate?: string;
  targets: readonly PublishingProgramTargetDraft[];
}

export interface PublishingProgramPreview {
  currentRevision: number;
  laneId: string;
  businessDate?: string;
  routes: readonly DistributionRoute[];
  affectedRouteIds: readonly string[];
  requiredAssetCountPerBusinessDate: number;
  rhythms: readonly {
    routeId: string;
    defaultSchedulePolicyId: string;
    effectiveSchedulePolicyId: string;
    operatingCalendarId?: string;
    active: boolean;
    source: "ROUTE_DEFAULT" | "WEEKDAY" | "DATE_OVERRIDE";
    slots: readonly string[];
  }[];
  next: StoredDistributionConfiguration;
}

function stableRouteId(laneId: string, target: PublishingProgramTargetDraft): string {
  const hash = createHash("sha256")
    .update(`${laneId}|${target.accountId}|${target.postingProfileId}|${target.schedulePolicyId}|${target.operatingCalendarId ?? ""}`)
    .digest("hex")
    .slice(0, 20);
  return `route:${hash}`;
}

export class PublishingProgramManagementService {
  constructor(
    private readonly store: DistributionConfigurationStorePort,
    private readonly accounts: () => readonly SocialAccount[]
  ) {}

  preview(draft: PublishingProgramDraft): PublishingProgramPreview {
    const current = this.store.load();
    const lane = current.config.lanes.find((item) => item.laneId === draft.laneId);
    if (!lane || !lane.enabled) throw new Error(`Publishing program lane ${draft.laneId} is missing or disabled`);
    const source = current.config.sources.find((item) => item.connectionId === lane.connectionId);
    if (!source || !source.enabled) throw new Error(`Publishing program source ${lane.connectionId} is missing or disabled`);
    if (draft.targets.length === 0) throw new Error("Publishing program requires at least one target");

    const calendars = new Map((current.operatingCalendars ?? []).map((item)=>[item.calendarId,item]));
    const accountMap = new Map(this.accounts().map((account) => [account.accountId, account]));
    const routes: DistributionRoute[] = draft.targets.map((target) => {
      const account = accountMap.get(target.accountId);
      if (!account || !account.enabled) throw new Error(`Target account ${target.accountId} is missing or disabled`);
      const posting = current.config.postingProfiles.find((item) => item.postingProfileId === target.postingProfileId);
      if (!posting || !posting.enabled) throw new Error(`Posting profile ${target.postingProfileId} is missing or disabled`);
      if (posting.platform !== account.platform) throw new Error(`Posting profile ${posting.postingProfileId} does not match account platform ${account.platform}`);
      const copy = current.config.copyProfiles.find((item) => item.copyProfileId === target.copyProfileId);
      if (!copy || !copy.enabled) throw new Error(`Copy profile ${target.copyProfileId} is missing or disabled`);
      if (!current.schedulePolicies[target.schedulePolicyId]) throw new Error(`Schedule policy ${target.schedulePolicyId} does not exist`);
      if (target.operatingCalendarId && !calendars.has(target.operatingCalendarId)) throw new Error(`Operating calendar ${target.operatingCalendarId} does not exist`);
      const routeId = target.routeId ?? stableRouteId(draft.laneId, target);
      return {
        routeId,
        displayName: `${lane.displayName} → ${account.platform} @${account.expectedHandle}`,
        laneId: draft.laneId,
        accountId: account.accountId,
        platform: account.platform,
        postingProfileId: posting.postingProfileId,
        copyProfileId: copy.copyProfileId,
        schedulePolicyId: target.schedulePolicyId,
        ...(target.operatingCalendarId ? { operatingCalendarId: target.operatingCalendarId } : {}),
        requirement: target.requirement,
        enabled: target.enabled ?? true
      };
    });

    const routeIds = routes.map((route) => route.routeId);
    if (new Set(routeIds).size !== routeIds.length) throw new Error("Publishing program contains duplicate route identity");
    const routeMap = new Map(current.config.routes.map((route) => [route.routeId, route]));
    for (const route of routes) routeMap.set(route.routeId, route);
    const nextConfig = { ...current.config, routes: [...routeMap.values()] };
    assertConfigurationReferentialIntegrity(nextConfig);

    const calendarRecord = Object.fromEntries((current.operatingCalendars ?? []).map((item)=>[item.calendarId,item]));
    const rhythms = routes.map((route) => {
      const decision = draft.businessDate
        ? effectiveRouteCalendar(route, draft.businessDate, calendarRecord)
        : { active:true, schedulePolicyId:route.schedulePolicyId, source:"ROUTE_DEFAULT" as const };
      return {
        routeId: route.routeId,
        defaultSchedulePolicyId: route.schedulePolicyId,
        effectiveSchedulePolicyId: decision.schedulePolicyId,
        ...(route.operatingCalendarId ? { operatingCalendarId: route.operatingCalendarId } : {}),
        active: decision.active,
        source: decision.source,
        slots: decision.active ? current.schedulePolicies[decision.schedulePolicyId]?.slots.map((slot) => slot.localTime) ?? [] : []
      };
    });
    const requiredAssetCountPerBusinessDate = Math.max(0, ...routes
      .filter((route) => route.enabled && route.requirement === "REQUIRED")
      .map((route) => rhythms.find((item)=>item.routeId===route.routeId)?.slots.length ?? 0));

    return {
      currentRevision: current.revision,
      laneId: draft.laneId,
      ...(draft.businessDate ? { businessDate:draft.businessDate } : {}),
      routes,
      affectedRouteIds: [...routeIds].sort(),
      requiredAssetCountPerBusinessDate,
      rhythms,
      next: { ...current, config: nextConfig }
    };
  }

  apply(draft: PublishingProgramDraft, expectedRevision: number, now: string): PublishingProgramPreview {
    const preview = this.preview(draft);
    if (preview.currentRevision !== expectedRevision) {
      throw new Error(`Publishing program preview is stale: expected revision ${expectedRevision}, current ${preview.currentRevision}`);
    }
    const stored = this.store.save({
      updatedAt: new Date(now).toISOString(),
      config: preview.next.config,
      schedulePolicies: preview.next.schedulePolicies,
      operatingCalendars: preview.next.operatingCalendars,
      planningPolicy: preview.next.planningPolicy,
      ...(preview.next.runtimePolicy ? { runtimePolicy: preview.next.runtimePolicy } : {})
    }, expectedRevision);
    return { ...preview, currentRevision: stored.revision, next: stored };
  }
}
