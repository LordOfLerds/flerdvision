import type { SocialAccount, SessionHealthState } from "../domain/browser-identity.js";
import type {
  BacklogItem,
  ContentAsset,
  DailyPlan,
  DailyPlanGap,
  DistributionRoute,
  PostingProfile,
  SourceConnection,
  SourceLane
} from "../domain/distribution.js";

export type AttentionSeverity = "INFO" | "WARNING" | "ACTION_REQUIRED" | "CRITICAL";

export interface AttentionItem {
  attentionId: string;
  severity: AttentionSeverity;
  kind: string;
  title: string;
  impact: string;
  routeId?: string;
  accountId?: string;
  assetId?: string;
  slotKey?: string;
  deepLink: string;
}

export interface ChannelReadiness {
  accountId: string;
  sessionHealth: SessionHealthState;
  identityVerified: boolean;
  surfaceContract: "CALIBRATED" | "UNVERIFIED" | "DRIFTED";
}

export interface RouteTestReadiness {
  routeId: string;
  sourcePassed: boolean;
  sessionPassed: boolean;
  identityPassed: boolean;
  prepareOnlyPasses: number;
  secretLivePassed: boolean;
  verificationPassed: boolean;
  cleanupPassed: boolean;
}

export interface TodaySlotView {
  scheduledFor: string;
  slotKey: string;
  deliveries: readonly {
    deliveryId: string;
    routeId: string;
    assetId: string;
    accountId: string;
    platform: string;
    format: string;
    requirement: string;
  }[];
}

export interface RouteManagementRow {
  routeId: string;
  displayName: string;
  sourceLane: string;
  sourcePath: string;
  channel: string;
  platform: string;
  postingProfile: string;
  requirement: string;
  enabled: boolean;
  readiness: "READY" | "NEEDS_TEST" | "BLOCKED";
}

export interface ControlCenterReadModel {
  today: {
    businessDate: string;
    totalDeliveries: number;
    gaps: number;
    backlog: number;
    slots: readonly TodaySlotView[];
  };
  routes: readonly RouteManagementRow[];
  attention: readonly AttentionItem[];
}

function gapAttention(gap: DailyPlanGap): AttentionItem {
  const severity: AttentionSeverity = gap.kind === "ACCOUNT_SLOT_CONFLICT" || gap.kind === "ROUTE_CONFIGURATION_INVALID"
    ? "CRITICAL"
    : gap.kind === "LATE_ARRIVAL_REQUIRES_REVIEW"
      ? "ACTION_REQUIRED"
      : "WARNING";
  const title = gap.kind === "MISSING_CONTENT"
    ? "Content fehlt für geplanten Slot"
    : gap.kind === "ACCOUNT_SLOT_CONFLICT"
      ? "Konto hat zwei Deliveries im selben Slot"
      : gap.kind === "ROUTE_CONFIGURATION_INVALID"
        ? "Route ist unvollständig konfiguriert"
        : "Späte Datei braucht Entscheidung";
  return {
    attentionId: `attention:${gap.gapId}`,
    severity,
    kind: gap.kind,
    title,
    impact: gap.reason,
    ...(gap.routeId ? { routeId: gap.routeId } : {}),
    ...(gap.accountId ? { accountId: gap.accountId } : {}),
    ...(gap.assetId ? { assetId: gap.assetId } : {}),
    ...(gap.slotKey ? { slotKey: gap.slotKey } : {}),
    deepLink: gap.routeId ? `/routes/${encodeURIComponent(gap.routeId)}` : `/today?date=${encodeURIComponent(gap.businessDate)}`
  };
}

function backlogAttention(item: BacklogItem): AttentionItem {
  return {
    attentionId: `attention:${item.backlogId}`,
    severity: item.reason === "MANUAL_REVIEW" ? "ACTION_REQUIRED" : "INFO",
    kind: "BACKLOG",
    title: item.reason === "MANUAL_REVIEW" ? "Backlog braucht Entscheidung" : "Content in Backlog verschoben",
    impact: `Asset ${item.assetId} hat in ${item.businessDate} keinen sicheren Slot erhalten (${item.reason}).`,
    routeId: item.routeId,
    assetId: item.assetId,
    deepLink: `/content/${encodeURIComponent(item.assetId)}`
  };
}

export interface ControlCenterProjectionInput {
  plan: DailyPlan;
  sources: readonly SourceConnection[];
  lanes: readonly SourceLane[];
  routes: readonly DistributionRoute[];
  postingProfiles: Readonly<Record<string, PostingProfile>>;
  accounts: readonly SocialAccount[];
  channelReadiness: readonly ChannelReadiness[];
  routeTests: readonly RouteTestReadiness[];
  assets: readonly ContentAsset[];
}

export function projectControlCenter(input: ControlCenterProjectionInput): ControlCenterReadModel {
  const lanes = new Map(input.lanes.map((lane) => [lane.laneId, lane]));
  const accounts = new Map(input.accounts.map((account) => [account.accountId, account]));
  const health = new Map(input.channelReadiness.map((item) => [item.accountId, item]));
  const tests = new Map(input.routeTests.map((item) => [item.routeId, item]));

  const slotGroups = new Map<string, TodaySlotView>();
  for (const delivery of input.plan.deliveries) {
    const key = `${delivery.scheduledFor}|${delivery.slotKey}`;
    const existing = slotGroups.get(key) ?? { scheduledFor: delivery.scheduledFor, slotKey: delivery.slotKey, deliveries: [] };
    slotGroups.set(key, {
      ...existing,
      deliveries: [...existing.deliveries, {
        deliveryId: delivery.deliveryId,
        routeId: delivery.routeId,
        assetId: delivery.assetId,
        accountId: delivery.accountId,
        platform: delivery.platform,
        format: delivery.format,
        requirement: delivery.requirement
      }]
    });
  }

  const routeRows = input.routes.map((route): RouteManagementRow => {
    const lane = lanes.get(route.laneId);
    const account = accounts.get(route.accountId);
    const channel = health.get(route.accountId);
    const test = tests.get(route.routeId);
    const posting = input.postingProfiles[route.postingProfileId];
    const blocked = !route.enabled || !lane?.enabled || !account?.enabled || channel?.sessionHealth !== "HEALTHY" || !channel.identityVerified || channel.surfaceContract === "DRIFTED";
    const tested = Boolean(test?.sourcePassed && test.sessionPassed && test.identityPassed && test.prepareOnlyPasses >= 3 && test.verificationPassed);
    return {
      routeId: route.routeId,
      displayName: route.displayName,
      sourceLane: lane?.displayName ?? "MISSING",
      sourcePath: lane?.folderPath ?? "MISSING",
      channel: account ? `@${account.expectedHandle}` : "MISSING",
      platform: route.platform,
      postingProfile: posting?.displayName ?? "MISSING",
      requirement: route.requirement,
      enabled: route.enabled,
      readiness: blocked ? "BLOCKED" : tested ? "READY" : "NEEDS_TEST"
    };
  });

  const attention: AttentionItem[] = [
    ...input.plan.gaps.map(gapAttention),
    ...input.plan.backlog.map(backlogAttention)
  ];
  for (const row of routeRows.filter((route) => route.readiness === "BLOCKED")) {
    attention.push({
      attentionId: `attention:route:${row.routeId}`,
      severity: "ACTION_REQUIRED",
      kind: "ROUTE_BLOCKED",
      title: `${row.displayName} ist nicht bereit`,
      impact: "Mindestens Source, Account, Session, Identity oder Surface Contract blockiert die Route.",
      routeId: row.routeId,
      deepLink: `/routes/${encodeURIComponent(row.routeId)}`
    });
  }

  return {
    today: {
      businessDate: input.plan.businessDate,
      totalDeliveries: input.plan.deliveries.length,
      gaps: input.plan.gaps.length,
      backlog: input.plan.backlog.length,
      slots: [...slotGroups.values()].sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor))
    },
    routes: routeRows,
    attention
  };
}
