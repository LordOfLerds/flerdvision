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

/** Login/session/identity is account-wide. Surface contracts are profile-specific below. */
export interface ChannelReadiness {
  accountId: string;
  sessionHealth: SessionHealthState;
  identityVerified: boolean;
  /** Legacy compatibility only. New runtime adapters must emit SurfaceReadiness separately. */
  surfaceContract?: "CALIBRATED" | "UNVERIFIED" | "DRIFTED";
}

export interface SurfaceReadiness {
  accountId: string;
  postingProfileId: string;
  surfaceContract: "CALIBRATED" | "UNVERIFIED" | "DRIFTED";
  contractId?: string;
  environmentFingerprint?: string;
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
  releaseSha?: string;
  surfaceContractId?: string;
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
  blockers: readonly string[];
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
  const severity: AttentionSeverity = [
    "ACCOUNT_SLOT_CONFLICT",
    "ACCOUNT_DAILY_CAP_CONFLICT",
    "ACCOUNT_MINIMUM_SPACING_CONFLICT",
    "ROUTE_CONFIGURATION_INVALID"
  ].includes(gap.kind)
    ? "CRITICAL"
    : gap.kind === "LATE_ARRIVAL_REQUIRES_REVIEW"
      ? "ACTION_REQUIRED"
      : "WARNING";

  const titleByKind: Record<DailyPlanGap["kind"], string> = {
    MISSING_CONTENT: "Content fehlt für geplanten Slot",
    ACCOUNT_SLOT_CONFLICT: "Konto hat zwei Deliveries im selben Slot",
    ACCOUNT_DAILY_CAP_CONFLICT: "Tageslimit des Kontos wird überschritten",
    ACCOUNT_MINIMUM_SPACING_CONFLICT: "Mindestabstand des Kontos wird verletzt",
    ROUTE_CONFIGURATION_INVALID: "Route ist unvollständig konfiguriert",
    LATE_ARRIVAL_REQUIRES_REVIEW: "Späte Datei braucht Entscheidung"
  };

  return {
    attentionId: `attention:${gap.gapId}`,
    severity,
    kind: gap.kind,
    title: titleByKind[gap.kind],
    impact: gap.reason,
    ...(gap.routeId ? { routeId: gap.routeId } : {}),
    ...(gap.accountId ? { accountId: gap.accountId } : {}),
    ...(gap.assetId ? { assetId: gap.assetId } : {}),
    ...(gap.slotKey ? { slotKey: gap.slotKey } : {}),
    deepLink: gap.routeId ? `/routes/${encodeURIComponent(gap.routeId)}` : `/today?date=${encodeURIComponent(gap.businessDate)}`
  };
}

function backlogAttention(item: BacklogItem): AttentionItem {
  const actionRequired = item.reason === "MANUAL_REVIEW";
  const carry = item.carryToBusinessDate ? ` Carry-over: ${item.carryToBusinessDate}.` : "";
  return {
    attentionId: `attention:${item.backlogId}`,
    severity: actionRequired ? "ACTION_REQUIRED" : "INFO",
    kind: "BACKLOG",
    title: actionRequired ? "Backlog braucht Entscheidung" : "Content in Backlog verschoben",
    impact: `Asset ${item.assetId} hat in ${item.businessDate} keinen sicheren Slot erhalten (${item.reason}).${carry}`,
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
  surfaceReadiness?: readonly SurfaceReadiness[];
  routeTests: readonly RouteTestReadiness[];
  assets: readonly ContentAsset[];
}

export function projectControlCenter(input: ControlCenterProjectionInput): ControlCenterReadModel {
  const lanes = new Map(input.lanes.map((lane) => [lane.laneId, lane]));
  const accounts = new Map(input.accounts.map((account) => [account.accountId, account]));
  const health = new Map(input.channelReadiness.map((item) => [item.accountId, item]));
  const surfaces = new Map((input.surfaceReadiness ?? []).map((item) => [`${item.accountId}|${item.postingProfileId}`, item]));
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
    const surface = surfaces.get(`${route.accountId}|${route.postingProfileId}`);
    const legacySurface = channel?.surfaceContract;
    const surfaceStatus = surface?.surfaceContract ?? legacySurface ?? "UNVERIFIED";
    const test = tests.get(route.routeId);
    const posting = input.postingProfiles[route.postingProfileId];
    const blockers: string[] = [];

    if (!route.enabled) blockers.push("route_paused");
    if (!lane?.enabled) blockers.push("source_lane_missing_or_paused");
    if (!account?.enabled) blockers.push("account_missing_or_paused");
    if (!channel || channel.sessionHealth !== "HEALTHY") blockers.push(`session_${channel?.sessionHealth ?? "UNKNOWN"}`);
    if (!channel?.identityVerified) blockers.push("identity_not_verified");
    if (surfaceStatus === "DRIFTED") blockers.push("surface_contract_drifted");

    const hardBlocked = blockers.length > 0;
    const platformQualified = surfaceStatus === "CALIBRATED";
    const tested = Boolean(
      test?.sourcePassed &&
      test.sessionPassed &&
      test.identityPassed &&
      test.prepareOnlyPasses >= 3 &&
      test.verificationPassed
    );

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
      readiness: hardBlocked ? "BLOCKED" : platformQualified && tested ? "READY" : "NEEDS_TEST",
      blockers
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
      impact: `Blocker: ${row.blockers.join(", ") || "unknown"}.`,
      routeId: row.routeId,
      deepLink: `/routes/${encodeURIComponent(row.routeId)}`
    });
  }
  for (const row of routeRows.filter((route) => route.readiness === "NEEDS_TEST")) {
    attention.push({
      attentionId: `attention:route-test:${row.routeId}`,
      severity: "WARNING",
      kind: "ROUTE_NEEDS_TEST",
      title: `${row.displayName} ist noch nicht qualifiziert`,
      impact: "Surface Contract und/oder die verpflichtenden Prepare-only-/Verification-Tests fehlen.",
      routeId: row.routeId,
      deepLink: `/test-lab?routeId=${encodeURIComponent(row.routeId)}`
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
