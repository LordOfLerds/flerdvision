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
import { addMinutes, instantForLocalDateTime } from "../domain/scheduling.js";

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

function routeGap(route: DistributionRoute, businessDate: string, kind: DailyPlanGap["kind"], reason: string, extra: Partial<DailyPlanGap> = {}): DailyPlanGap {
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

function backlog(route: DistributionRoute, asset: ContentAsset, businessDate: string, reason: BacklogItem["reason"]): BacklogItem {
  return {
    backlogId: `backlog:${sha(`${route.routeId}|${asset.assetId}|${businessDate}|${reason}`)}`,
    businessDate,
    routeId: route.routeId,
    assetId: asset.assetId,
    reason
  };
}

export interface DailyPlannerInput {
  businessDate: string;
  generatedAt: string;
  assets: readonly ContentAsset[];
  lanes: readonly SourceLane[];
  routes: readonly DistributionRoute[];
  catalog: PlanningCatalog;
  policy: DistributionPlanningPolicy;
}

export class DistributionPlanner {
  plan(input: DailyPlannerInput): DailyPlan {
    const lanes = new Map(input.lanes.map((lane) => [lane.laneId, lane]));
    const deliveries: PlannedDelivery[] = [];
    const gaps: DailyPlanGap[] = [];
    const backlogItems: BacklogItem[] = [];

    for (const route of input.routes.filter((candidate) => candidate.enabled)) {
      const lane = lanes.get(route.laneId);
      try {
        assertRouteCatalogIntegrity(route, lane, input.catalog);
      } catch (error) {
        gaps.push(routeGap(route, input.businessDate, "ROUTE_CONFIGURATION_INVALID", error instanceof Error ? error.message : String(error)));
        continue;
      }
      if (!lane) continue;

      const schedule = input.catalog.schedulePolicies[route.schedulePolicyId]!;
      const posting = input.catalog.postingProfiles[route.postingProfileId]!;
      const copy = input.catalog.copyProfiles[route.copyProfileId]!;
      const routeAssets = sortAssets(
        input.assets.filter((asset) =>
          asset.laneId === route.laneId &&
          asset.state === "READY" &&
          asset.scheduledBusinessDate === input.businessDate
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
            backlogItems.push(backlog(route, asset, input.businessDate, "NEXT_DAY"));
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

        // NEXT_AVAILABLE_SLOT preserves a late asset for the next still-valid slot.
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
        backlogItems.push(backlog(route, asset, input.businessDate, input.policy.overflow === "BACKLOG_NEXT_DAY" ? "NEXT_DAY" : "MANUAL_REVIEW"));
      }
    }

    // A social account cannot receive two distinct deliveries in the same slot. Keep neither:
    // silently picking one would make route iteration order a hidden business rule.
    const collisionGroups = new Map<string, PlannedDelivery[]>();
    for (const delivery of deliveries) {
      const key = `${delivery.accountId}|${delivery.scheduledFor}`;
      const group = collisionGroups.get(key) ?? [];
      group.push(delivery);
      collisionGroups.set(key, group);
    }
    const conflicted = new Set<string>();
    for (const group of collisionGroups.values()) {
      if (group.length < 2) continue;
      for (const delivery of group) {
        conflicted.add(delivery.deliveryId);
        const route = input.routes.find((candidate) => candidate.routeId === delivery.routeId)!;
        gaps.push(routeGap(route, input.businessDate, "ACCOUNT_SLOT_CONFLICT", `Account ${delivery.accountId} has multiple deliveries at ${delivery.scheduledFor}`, { slotKey: delivery.slotKey, assetId: delivery.assetId }));
      }
    }

    const acceptedDeliveries = deliveries.filter((delivery) => !conflicted.has(delivery.deliveryId));
    return {
      planId: `daily-plan:${input.businessDate}:${sha(`${input.businessDate}|${input.generatedAt}|${acceptedDeliveries.map((d) => d.deliveryId).sort().join(",")}`)}`,
      businessDate: input.businessDate,
      generatedAt: new Date(input.generatedAt).toISOString(),
      deliveries: acceptedDeliveries,
      gaps,
      backlog: backlogItems
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
