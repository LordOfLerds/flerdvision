import { createHash } from "node:crypto";
import type { PublicationIntent } from "../domain/model.js";
import {
  type BacklogItem,
  type ContentAsset,
  type DailyPlan,
  type DailyPlanGap,
  type DistributionPlanningPolicy,
  type DistributionRoute,
  type PlannedDelivery,
  type PlanningCatalog,
  type SourceLane,
  assertRouteCatalogIntegrity
} from "../domain/distribution.js";
import { effectiveRouteCalendar } from "../domain/operating-calendar.js";
import { addMinutes, instantForLocalDateTime, minutesBetween } from "../domain/scheduling.js";

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function numericPrefix(name: string): number {
  const match = /^\s*(\d+)/.exec(name);
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
}

function sortAssets(assets: readonly ContentAsset[], policy: DistributionPlanningPolicy["contentOrder"]): ContentAsset[] {
  return [...assets].sort((a, b) => {
    if (policy === "MANUAL_PRIORITY") {
      const ap = a.manualPriority ?? Number.POSITIVE_INFINITY;
      const bp = b.manualPriority ?? Number.POSITIVE_INFINITY;
      if (ap !== bp) return ap - bp;
    }
    if (policy === "FILENAME_NUMERIC_PREFIX") {
      const an = numericPrefix(a.filename);
      const bn = numericPrefix(b.filename);
      if (an !== bn) return an - bn;
      const lexical = a.filename.localeCompare(b.filename, "de-AT", { numeric: true, sensitivity: "base" });
      if (lexical !== 0) return lexical;
    }
    const observed = a.observedAt.localeCompare(b.observedAt);
    if (observed !== 0) return observed;
    return a.assetId.localeCompare(b.assetId);
  });
}

function nextBusinessDate(businessDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(businessDate);
  if (!match) throw new Error(`Invalid business date: ${businessDate}`);
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + 1));
  return date.toISOString().slice(0, 10);
}

function routeGap(
  route: DistributionRoute,
  businessDate: string,
  kind: DailyPlanGap["kind"],
  reason: string,
  extra: Partial<DailyPlanGap> = {}
): DailyPlanGap {
  return {
    gapId: `gap:${sha(`${route.routeId}|${businessDate}|${kind}|${reason}|${extra.slotKey ?? ""}|${extra.assetId ?? ""}`)}`,
    kind,
    businessDate,
    routeId: route.routeId,
    accountId: route.accountId,
    reason,
    ...extra
  };
}

function backlog(
  route: DistributionRoute,
  asset: ContentAsset,
  businessDate: string,
  reason: BacklogItem["reason"],
  carryToBusinessDate?: string
): BacklogItem {
  const item: BacklogItem = {
    backlogId: `backlog:${sha(`${route.routeId}|${asset.assetId}|${businessDate}|${reason}|${carryToBusinessDate ?? ""}`)}`,
    businessDate,
    routeId: route.routeId,
    assetId: asset.assetId,
    reason
  };
  if (carryToBusinessDate) Object.assign(item, { carriedFromBusinessDate: businessDate, carryToBusinessDate });
  return item;
}

function dedupeById<T>(items: readonly T[], id: (item: T) => string): T[] {
  return [...new Map(items.map((item) => [id(item), item])).values()];
}

export interface DailyPlannerInput {
  businessDate: string;
  generatedAt: string;
  assets: readonly ContentAsset[];
  lanes: readonly SourceLane[];
  routes: readonly DistributionRoute[];
  catalog: PlanningCatalog;
  policy: DistributionPlanningPolicy;
  /** Explicit carry-over from earlier DailyPlans. Nothing is inferred from old files alone. */
  carryInBacklog?: readonly BacklogItem[];
}

export class DistributionPlanner {
  plan(input: DailyPlannerInput): DailyPlan {
    const lanes = new Map(input.lanes.map((lane) => [lane.laneId, lane]));
    const deliveries: PlannedDelivery[] = [];
    const gaps: DailyPlanGap[] = [];
    const backlogItems: BacklogItem[] = [];
    const carryToNextDay = nextBusinessDate(input.businessDate);

    for (const route of input.routes.filter((candidate) => candidate.enabled)) {
      const lane = lanes.get(route.laneId);
      try {
        assertRouteCatalogIntegrity(route, lane, input.catalog);
      } catch (error) {
        gaps.push(routeGap(route, input.businessDate, "ROUTE_CONFIGURATION_INVALID", error instanceof Error ? error.message : String(error)));
        continue;
      }
      if (!lane) continue;

      const calendar = effectiveRouteCalendar(route, input.businessDate, input.catalog.operatingCalendars ?? {});
      if (!calendar.active) continue;
      const schedule = input.catalog.schedulePolicies[calendar.schedulePolicyId];
      if (!schedule) {
        gaps.push(routeGap(route, input.businessDate, "ROUTE_CONFIGURATION_INVALID", `Effective schedule policy ${calendar.schedulePolicyId} does not exist`));
        continue;
      }
      const posting = input.catalog.postingProfiles[route.postingProfileId]!;
      const copy = input.catalog.copyProfiles[route.copyProfileId]!;
      const carriedAssetIds = new Set(
        (input.carryInBacklog ?? [])
          .filter((item) => item.routeId === route.routeId && item.carryToBusinessDate === input.businessDate)
          .map((item) => item.assetId)
      );
      const routeAssets = sortAssets(
        input.assets.filter((asset) =>
          asset.laneId === route.laneId &&
          asset.state === "READY" &&
          // An asset without a scheduledBusinessDate is unpinned: simple source topologies (a
          // plain folder, no week/day naming) carry no date the interpreter could derive, and
          // such content is meant for the earliest open slot. Only assets whose source metadata
          // pinned them to a specific date stay date-exact.
          (asset.scheduledBusinessDate === undefined || asset.scheduledBusinessDate === input.businessDate || carriedAssetIds.has(asset.assetId))
        ),
        input.policy.contentOrder
      );

      let assetIndex = 0;
      for (const slot of schedule.slots) {
        const targetAt = instantForLocalDateTime(input.businessDate, slot.localTime, schedule.timeZone);
        const windowStartAt = addMinutes(targetAt, -schedule.windowMinutes);
        const windowEndAt = addMinutes(targetAt, schedule.windowMinutes);
        let asset = routeAssets[assetIndex];

        while (asset && asset.readyAt && asset.readyAt > windowEndAt) {
          if (input.policy.lateArrival === "NEXT_AVAILABLE_SLOT") break;
          if (input.policy.lateArrival === "NEXT_DAY") {
            backlogItems.push(backlog(route, asset, input.businessDate, "NEXT_DAY", carryToNextDay));
            assetIndex += 1;
            asset = routeAssets[assetIndex];
            continue;
          }
          if (input.policy.lateArrival === "MANUAL_REVIEW") {
            gaps.push(routeGap(route, input.businessDate, "LATE_ARRIVAL_REQUIRES_REVIEW", `Asset ${asset.assetId} became ready after ${slot.key} window`, { slotKey: slot.key, assetId: asset.assetId }));
            backlogItems.push(backlog(route, asset, input.businessDate, "MANUAL_REVIEW"));
            assetIndex += 1;
            asset = routeAssets[assetIndex];
            continue;
          }
          assetIndex += 1;
          asset = routeAssets[assetIndex];
        }

        if (!asset) {
          gaps.push(routeGap(route, input.businessDate, "MISSING_CONTENT", `No ready content for ${slot.key}`, { slotKey: slot.key }));
          continue;
        }
        if (asset.readyAt && asset.readyAt > windowEndAt) {
          gaps.push(routeGap(route, input.businessDate, "MISSING_CONTENT", `No asset was ready before ${slot.key} closed`, { slotKey: slot.key }));
          continue;
        }

        const deliveryId = `delivery:${sha(`${route.routeId}|${asset.assetId}|${targetAt}`)}`;
        deliveries.push({
          deliveryId,
          routeId: route.routeId,
          assetId: asset.assetId,
          contentId: asset.contentId,
          creatorId: asset.creatorId,
          laneId: route.laneId,
          accountId: route.accountId,
          platform: route.platform,
          format: posting.format,
          postingProfileId: posting.postingProfileId,
          copyProfileId: copy.copyProfileId,
          copyVersionId: copy.versionId,
          schedulePolicyId: calendar.schedulePolicyId,
          requirement: route.requirement,
          businessDate: input.businessDate,
          slotKey: slot.key,
          scheduledFor: targetAt,
          windowStartAt,
          windowEndAt
        });
        assetIndex += 1;
      }

      for (const asset of routeAssets.slice(assetIndex)) {
        backlogItems.push(backlog(route, asset, input.businessDate, input.policy.overflow === "BACKLOG_NEXT_DAY" ? "NEXT_DAY" : "MANUAL_REVIEW", input.policy.overflow === "BACKLOG_NEXT_DAY" ? carryToNextDay : undefined));
      }
    }

    const conflicted = new Set<string>();
    const collisionGroups = new Map<string, PlannedDelivery[]>();
    for (const delivery of deliveries) {
      const key = `${delivery.accountId}|${delivery.scheduledFor}`;
      const group = collisionGroups.get(key) ?? [];
      group.push(delivery);
      collisionGroups.set(key, group);
    }
    for (const group of collisionGroups.values()) {
      if (group.length < 2) continue;
      for (const delivery of group) {
        conflicted.add(delivery.deliveryId);
        const route = input.routes.find((candidate) => candidate.routeId === delivery.routeId)!;
        gaps.push(routeGap(route, input.businessDate, "ACCOUNT_SLOT_CONFLICT", `Account ${delivery.accountId} has multiple deliveries at ${delivery.scheduledFor}`, { slotKey: delivery.slotKey, assetId: delivery.assetId }));
      }
    }

    const byAccount = new Map<string, PlannedDelivery[]>();
    for (const delivery of deliveries.filter((item) => !conflicted.has(item.deliveryId))) {
      const group = byAccount.get(delivery.accountId) ?? [];
      group.push(delivery);
      byAccount.set(delivery.accountId, group);
    }
    for (const [accountId, group] of byAccount) {
      const policies = group.map((delivery) => input.catalog.schedulePolicies[delivery.schedulePolicyId]!);
      const effectiveCap = Math.min(...policies.map((policy) => policy.maxPerAccountPerBusinessDate));
      const effectiveSpacing = Math.max(...policies.map((policy) => policy.minimumSpacingMinutes));
      if (group.length > effectiveCap) {
        for (const delivery of group) {
          conflicted.add(delivery.deliveryId);
          const route = input.routes.find((candidate) => candidate.routeId === delivery.routeId)!;
          gaps.push(routeGap(route, input.businessDate, "ACCOUNT_DAILY_CAP_CONFLICT", `Account ${accountId} has ${group.length} deliveries but effective daily cap is ${effectiveCap}`, { slotKey: delivery.slotKey, assetId: delivery.assetId }));
          const asset = input.assets.find((candidate) => candidate.assetId === delivery.assetId);
          if (asset) backlogItems.push(backlog(route, asset, input.businessDate, "ACCOUNT_CAP", carryToNextDay));
        }
        continue;
      }

      const ordered = [...group].sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor) || a.deliveryId.localeCompare(b.deliveryId));
      for (let i = 1; i < ordered.length; i += 1) {
        const previous = ordered[i - 1]!;
        const current = ordered[i]!;
        if (minutesBetween(previous.scheduledFor, current.scheduledFor) >= effectiveSpacing) continue;
        for (const delivery of [previous, current]) {
          if (conflicted.has(delivery.deliveryId)) continue;
          conflicted.add(delivery.deliveryId);
          const route = input.routes.find((candidate) => candidate.routeId === delivery.routeId)!;
          gaps.push(routeGap(route, input.businessDate, "ACCOUNT_MINIMUM_SPACING_CONFLICT", `Account ${accountId} violates effective minimum spacing of ${effectiveSpacing} minutes`, { slotKey: delivery.slotKey, assetId: delivery.assetId }));
          const asset = input.assets.find((candidate) => candidate.assetId === delivery.assetId);
          if (asset) backlogItems.push(backlog(route, asset, input.businessDate, "ACCOUNT_SPACING", carryToNextDay));
        }
      }
    }

    const acceptedDeliveries = deliveries
      .filter((delivery) => !conflicted.has(delivery.deliveryId))
      .sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor) || a.accountId.localeCompare(b.accountId) || a.routeId.localeCompare(b.routeId) || a.assetId.localeCompare(b.assetId));
    const stableGaps = dedupeById(gaps, (item) => item.gapId).sort((a, b) => a.kind.localeCompare(b.kind) || (a.routeId ?? "").localeCompare(b.routeId ?? "") || (a.slotKey ?? "").localeCompare(b.slotKey ?? "") || (a.assetId ?? "").localeCompare(b.assetId ?? ""));
    const stableBacklog = dedupeById(backlogItems, (item) => item.backlogId).sort((a, b) => (a.carryToBusinessDate ?? "").localeCompare(b.carryToBusinessDate ?? "") || a.routeId.localeCompare(b.routeId) || a.assetId.localeCompare(b.assetId) || a.reason.localeCompare(b.reason));

    const semanticPayload = JSON.stringify({ businessDate: input.businessDate, deliveries: acceptedDeliveries, gaps: stableGaps, backlog: stableBacklog });
    return {
      planId: `daily-plan:${input.businessDate}:${sha(semanticPayload)}`,
      businessDate: input.businessDate,
      generatedAt: new Date(input.generatedAt).toISOString(),
      deliveries: acceptedDeliveries,
      gaps: stableGaps,
      backlog: stableBacklog
    };
  }
}

export function publicationIntentForDelivery(delivery: PlannedDelivery): PublicationIntent {
  const stable = sha(`${delivery.deliveryId}|${delivery.copyVersionId}`);
  return {
    intentId: `intent:${stable}`,
    contentId: delivery.contentId,
    creatorId: delivery.creatorId,
    platform: delivery.platform,
    accountId: delivery.accountId,
    format: delivery.format,
    copyVersionId: delivery.copyVersionId,
    scheduledFor: delivery.scheduledFor,
    idempotencyKey: `distribution:${stable}`
  };
}
