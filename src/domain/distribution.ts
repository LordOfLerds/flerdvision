import type { Instant, Platform, PublicationFormat } from "./model.js";
import type { OperatingCalendar } from "./operating-calendar.js";
import type { SchedulingPolicy } from "./scheduling.js";

/**
 * R1-R3 replacement model for the legacy one-folder-per-account binding.
 *
 * SourceConnection -> SourceLane -> DistributionRoute -> PostingProfile -> DailyPlan.
 * A lane may feed many channels and a channel may receive many lanes.
 */

export type SourceConnectionKind = "google_drive" | "local_folder";
export type SourceDispositionMode = "database_only" | "drive_metadata" | "sidecar" | "move_on_complete";

export interface SourceDispositionPolicy {
  mode: SourceDispositionMode;
  completedDestinationRef?: string;
  leavePartialUntouched: boolean;
  leaveBlockedUntouched: boolean;
}

export interface SourceConnection {
  connectionId: string;
  displayName: string;
  kind: SourceConnectionKind;
  rootRef: string;
  enabled: boolean;
  disposition: SourceDispositionPolicy;
}

export type SourceLaneInterpretation =
  | { kind: "flat" }
  | {
      kind: "creator_week_day";
      creatorAlias?: string;
      /** Explicit week-folder -> Monday ISO-date mapping; no calendar date is guessed from a label. */
      weekStartBySegment?: Readonly<Record<string,string>>;
      /** Optional folder-name -> posting hint mapping carried with workspace config. */
      formatFolderHints?: Readonly<Record<string,readonly string[]>>;
    }
  | { kind: "metadata"; creatorField?: string; businessDateField?: string };

export interface SourceLane {
  laneId: string;
  connectionId: string;
  displayName: string;
  /** Explicit owner for lanes whose source metadata/path does not provide creator identity. */
  creatorId?: string;
  /** Provider-stable locator: Drive folder id or source-relative local path. */
  folderRef: string;
  /** Human-facing path/label only; never used as a technical local filesystem locator. */
  folderPath: string;
  interpretation: SourceLaneInterpretation;
  enabled: boolean;
}

export type ActivationMode = "NEW_ONLY" | "SINCE" | "IMPORT_BACKLOG" | "SELECTED";

export interface SourceActivationCursor {
  laneId: string;
  mode: ActivationMode;
  activatedAt: Instant;
  since?: Instant;
  selectedExternalObjectIds?: readonly string[];
}

export type ContentAssetState = "OBSERVED" | "STABILIZING" | "READY" | "BLOCKED" | "COMPLETE";

export interface ContentAsset {
  assetId: string;
  contentId: string;
  laneId: string;
  creatorId: string;
  sourceObservationId: string;
  sourceRef: string;
  externalObjectId: string;
  filename: string;
  mediaFingerprint: string;
  observedAt: Instant;
  state: ContentAssetState;
  readyAt?: Instant;
  scheduledBusinessDate?: string;
  manualPriority?: number;
  metadata: Readonly<Record<string, string>>;
}

export interface AssetReadinessEvidence {
  assetId: string;
  checkedAt: Instant;
  stableFingerprint: boolean;
  stableSize: boolean;
  mediaReadable: boolean;
  durationSeconds?: number;
  note?: string;
}

export function isAssetReady(asset: ContentAsset, evidence: AssetReadinessEvidence): boolean {
  return asset.assetId === evidence.assetId &&
    evidence.stableFingerprint &&
    evidence.stableSize &&
    evidence.mediaReadable &&
    (evidence.durationSeconds === undefined || evidence.durationSeconds > 0);
}

export interface CopyProfile {
  copyProfileId: string;
  displayName: string;
  versionId: string;
  strategy: "static" | "template" | "ai_assisted";
  enabled: boolean;
}

interface PostingProfileBase {
  postingProfileId: string;
  displayName: string;
  enabled: boolean;
}

export interface InstagramPostingProfile extends PostingProfileBase {
  platform: "instagram";
  format: "reel" | "trial_reel" | "story";
  commentsEnabled: boolean;
  shareToFeed: boolean;
  crosspostFacebook: boolean;
}

export interface TikTokPostingProfile extends PostingProfileBase {
  platform: "tiktok";
  format: "tiktok";
  visibility: "only_you" | "friends" | "followers" | "everyone";
  commentsEnabled: boolean;
  duetEnabled: boolean;
  stitchEnabled: boolean;
}

export interface YouTubePostingProfile extends PostingProfileBase {
  platform: "youtube";
  format: "short";
  visibility: "private" | "unlisted" | "public";
  commentsEnabled: boolean;
}

export type PostingProfile = InstagramPostingProfile | TikTokPostingProfile | YouTubePostingProfile;

export type DeliveryRequirement = "REQUIRED" | "OPTIONAL";

export interface DistributionRoute {
  routeId: string;
  displayName: string;
  laneId: string;
  accountId: string;
  platform: Platform;
  postingProfileId: string;
  copyProfileId: string;
  /** Default posting rhythm. OperatingCalendar may override this on weekdays or dates. */
  schedulePolicyId: string;
  operatingCalendarId?: string;
  requirement: DeliveryRequirement;
  enabled: boolean;
}

export type ContentOrderPolicy = "FILENAME_NUMERIC_PREFIX" | "OBSERVED_AT" | "MANUAL_PRIORITY";
export type LateArrivalPolicy = "NEXT_AVAILABLE_SLOT" | "NEXT_DAY" | "MANUAL_REVIEW" | "REJECT";
export type OverflowPolicy = "BACKLOG_NEXT_DAY" | "MANUAL_REVIEW";

export interface DistributionPlanningPolicy {
  contentOrder: ContentOrderPolicy;
  lateArrival: LateArrivalPolicy;
  overflow: OverflowPolicy;
}

export interface PlanningCatalog {
  postingProfiles: Readonly<Record<string, PostingProfile>>;
  copyProfiles: Readonly<Record<string, CopyProfile>>;
  schedulePolicies: Readonly<Record<string, SchedulingPolicy>>;
  operatingCalendars?: Readonly<Record<string, OperatingCalendar>>;
}

export interface PlannedDelivery {
  deliveryId: string;
  routeId: string;
  assetId: string;
  contentId: string;
  creatorId: string;
  laneId: string;
  accountId: string;
  platform: Platform;
  format: PublicationFormat;
  postingProfileId: string;
  copyProfileId: string;
  copyVersionId: string;
  schedulePolicyId: string;
  requirement: DeliveryRequirement;
  businessDate: string;
  slotKey: string;
  scheduledFor: Instant;
  windowStartAt: Instant;
  windowEndAt: Instant;
}

export type PlanGapKind =
  | "MISSING_CONTENT"
  | "ACCOUNT_SLOT_CONFLICT"
  | "ACCOUNT_DAILY_CAP_CONFLICT"
  | "ACCOUNT_MINIMUM_SPACING_CONFLICT"
  | "ROUTE_CONFIGURATION_INVALID"
  | "LATE_ARRIVAL_REQUIRES_REVIEW";

export interface DailyPlanGap {
  gapId: string;
  kind: PlanGapKind;
  businessDate: string;
  routeId?: string;
  accountId?: string;
  slotKey?: string;
  assetId?: string;
  reason: string;
}

export interface BacklogItem {
  backlogId: string;
  businessDate: string;
  routeId: string;
  assetId: string;
  reason: "NO_SLOT" | "NEXT_DAY" | "MANUAL_REVIEW" | "ACCOUNT_CAP" | "ACCOUNT_SPACING";
  carriedFromBusinessDate?: string;
  carryToBusinessDate?: string;
}

export interface DailyPlan {
  planId: string;
  businessDate: string;
  generatedAt: Instant;
  deliveries: readonly PlannedDelivery[];
  gaps: readonly DailyPlanGap[];
  backlog: readonly BacklogItem[];
}

export interface DeliveryAggregate {
  assetId: string;
  requiredDeliveryIds: readonly string[];
  optionalDeliveryIds: readonly string[];
  verifiedDeliveryIds: readonly string[];
  waivedDeliveryIds: readonly string[];
  failedDeliveryIds: readonly string[];
  status: "PENDING" | "PARTIAL" | "COMPLETE" | "BLOCKED";
}

export function aggregateDeliveryStatus(input: Omit<DeliveryAggregate, "status">): DeliveryAggregate {
  const terminal = new Set([...input.verifiedDeliveryIds, ...input.waivedDeliveryIds]);
  const requiredComplete = input.requiredDeliveryIds.every((id) => terminal.has(id));
  const anySuccess = terminal.size > 0;
  const anyFailedRequired = input.failedDeliveryIds.some((id) => input.requiredDeliveryIds.includes(id));
  const status: DeliveryAggregate["status"] = requiredComplete
    ? "COMPLETE"
    : anyFailedRequired
      ? (anySuccess ? "PARTIAL" : "BLOCKED")
      : anySuccess
        ? "PARTIAL"
        : "PENDING";
  return { ...input, status };
}

export function assertRouteCatalogIntegrity(
  route: DistributionRoute,
  lane: SourceLane | undefined,
  catalog: PlanningCatalog
): void {
  if (!route.enabled) return;
  if (!lane || !lane.enabled) throw new Error(`Route ${route.routeId} references a missing or disabled lane`);
  const posting = catalog.postingProfiles[route.postingProfileId];
  if (!posting || !posting.enabled) throw new Error(`Route ${route.routeId} references a missing or disabled posting profile`);
  if (posting.platform !== route.platform) throw new Error(`Route ${route.routeId} platform does not match posting profile`);
  const copy = catalog.copyProfiles[route.copyProfileId];
  if (!copy || !copy.enabled) throw new Error(`Route ${route.routeId} references a missing or disabled copy profile`);
  if (!catalog.schedulePolicies[route.schedulePolicyId]) throw new Error(`Route ${route.routeId} references a missing schedule policy`);
  if (route.operatingCalendarId && !catalog.operatingCalendars?.[route.operatingCalendarId]) {
    throw new Error(`Route ${route.routeId} references a missing operating calendar`);
  }
}
