import type { BacklogItem, ContentAsset, DailyPlan, DeliveryAggregate, DistributionRoute, SourceLane } from "../domain/distribution.js";

export type ContentQueueStatus = "OBSERVED" | "STABILIZING" | "READY" | "PLANNED" | "BACKLOG" | "BLOCKED" | "PARTIAL" | "COMPLETE";

export interface ContentQueueItem {
  assetId: string;
  filename: string;
  laneId: string;
  laneName: string;
  sourcePath: string;
  creatorId: string;
  assetState: string;
  status: ContentQueueStatus;
  routeIds: readonly string[];
  targetAccountIds: readonly string[];
  deliveryIds: readonly string[];
  scheduledFor: readonly string[];
  backlogReasons: readonly BacklogItem["reason"][];
  aggregateStatus?: DeliveryAggregate["status"];
  deepLink: string;
}

export function projectContentQueue(input: {
  assets: readonly ContentAsset[];
  plan: DailyPlan;
  lanes: readonly SourceLane[];
  routes: readonly DistributionRoute[];
  aggregates?: readonly DeliveryAggregate[];
}): readonly ContentQueueItem[] {
  const lanes = new Map(input.lanes.map((item) => [item.laneId, item]));
  const aggregates = new Map((input.aggregates ?? []).map((item) => [item.assetId, item]));
  const rows = input.assets.map((asset): ContentQueueItem => {
    const deliveries = input.plan.deliveries.filter((item) => item.assetId === asset.assetId);
    const backlog = input.plan.backlog.filter((item) => item.assetId === asset.assetId);
    const aggregate = aggregates.get(asset.assetId);
    const routeIds = [...new Set([...deliveries.map((item) => item.routeId), ...backlog.map((item) => item.routeId)])].sort();
    const lane = lanes.get(asset.laneId);
    let status: ContentQueueStatus;
    if (aggregate?.status === "COMPLETE" || asset.state === "COMPLETE") status = "COMPLETE";
    else if (aggregate?.status === "PARTIAL") status = "PARTIAL";
    else if (asset.state === "BLOCKED" || aggregate?.status === "BLOCKED") status = "BLOCKED";
    else if (backlog.length > 0) status = "BACKLOG";
    else if (deliveries.length > 0) status = "PLANNED";
    else status = asset.state;
    return {
      assetId: asset.assetId,
      filename: asset.filename,
      laneId: asset.laneId,
      laneName: lane?.displayName ?? "MISSING",
      sourcePath: lane?.folderPath ?? "MISSING",
      creatorId: asset.creatorId,
      assetState: asset.state,
      status,
      routeIds,
      targetAccountIds: [...new Set(deliveries.map((item) => item.accountId))].sort(),
      deliveryIds: deliveries.map((item) => item.deliveryId).sort(),
      scheduledFor: deliveries.map((item) => item.scheduledFor).sort(),
      backlogReasons: backlog.map((item) => item.reason),
      ...(aggregate ? { aggregateStatus: aggregate.status } : {}),
      deepLink: `/content/${encodeURIComponent(asset.assetId)}`
    };
  });
  const rank: Record<ContentQueueStatus, number> = { BLOCKED:0, PARTIAL:1, STABILIZING:2, READY:3, BACKLOG:4, PLANNED:5, OBSERVED:6, COMPLETE:7 };
  return rows.sort((a, b) => rank[a.status] - rank[b.status] || a.filename.localeCompare(b.filename) || a.assetId.localeCompare(b.assetId));
}
