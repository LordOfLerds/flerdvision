import type { StoredDistributionConfiguration } from "../domain/distribution-ports.js";
import type { StoredPublicationIntent, ScheduleReservation } from "../domain/control-plane.js";
import type { StoredContentAssetRevision } from "../domain/distribution-runtime-ports.js";
import type { Incident, KillSwitch } from "../domain/operations.js";
import type { SchedulePause } from "../domain/operator-ports.js";
import type { PublicationState } from "../domain/states.js";
import { businessDateForInstant } from "../domain/scheduling.js";
import { filenameParts } from "../adapters/publish/workspace-payload-resolver.js";
import {
  driveFolderUrl,
  germanBlocker,
  germanBlockReason,
  germanDayLabel,
  germanIncident,
  germanPlatformLabel,
  germanState,
  operatorMessageText,
  renderOperatorMessage,
  type OperatorMessageContext,
  type OperatorNextSlot
} from "./operator-message.js";

/** One channel as the operator names it in flerdvision.json, mapped to its exact account. */
export interface OperatorChannelRef {
  key: string;
  name: string;
  platform: string;
  accountId: string;
  /**
   * The channel's own Google-Drive folder as a link. Every "put a video in Drive" message names
   * it, because the operator cannot act on a folder they have to go and find first.
   */
  driveFolderUrl?: string;
}

/**
 * What one channel can do today. A channel whose route is not released yet has no intents, so
 * without this it simply vanished from the plan -- which is how YouTube went missing for a week
 * without anyone being told why.
 */
export interface OperatorChannelStatus {
  channelKey: string;
  /** False while the route still needs its release run. */
  qualified: boolean;
  /** German reason the channel cannot post; undefined when nothing is in the way. */
  reason?: string;
  readyAssets: number;
}

export interface OperatorPlanViewStores {
  control: {
    listIntents(states?: readonly PublicationState[]): readonly StoredPublicationIntent[];
    getReservationForIntent(intentId: string): ScheduleReservation | null;
    listIncidents(statuses?: readonly Incident["status"][]): readonly Incident[];
    listKillSwitches(enabledOnly?: boolean): readonly KillSwitch[];
    getVerifiedPublication?(intentId: string): { permalink?: string } | null;
  };
  state: { listAssets(): readonly StoredContentAssetRevision[] };
  pauses: { listSchedulePauses(): readonly SchedulePause[] };
  /** Optional release state per channel; without it a channel without posts is simply named. */
  channelStatus?: () => readonly OperatorChannelStatus[];
}

/**
 * Gives every channel the Google-Drive folder that actually feeds it, resolved through its own
 * enabled route and lane. Without this the operator is told to "put a video in Drive" and then
 * has to go and work out which of the folders that means.
 */
export function withDriveFolders(
  channels: readonly OperatorChannelRef[],
  stored: StoredDistributionConfiguration | undefined
): readonly OperatorChannelRef[] {
  if (!stored) return channels;
  const driveConnections = new Set(stored.config.sources.filter((source) => source.kind === "google_drive").map((source) => source.connectionId));
  const laneById = new Map(stored.config.lanes.map((lane) => [lane.laneId, lane]));
  return channels.map((channel) => {
    const lanes = stored.config.routes
      .filter((route) => route.enabled && route.accountId === channel.accountId)
      .map((route) => laneById.get(route.laneId))
      .filter((lane) => lane?.enabled && driveConnections.has(lane.connectionId));
    const url = driveFolderUrl(lanes[0]?.folderRef);
    return url ? { ...channel, driveFolderUrl: url } : channel;
  });
}

/**
 * Doctor rows -> the one sentence the checklist needs. A channel counts as released as soon as
 * one of its routes is, and a channel whose only obstacle is an empty Drive folder is released
 * -- it just has nothing to post.
 */
export function operatorChannelStatusFromDoctor(report: {
  channels: readonly {
    channelKey: string;
    routes: readonly { readyForAutonomousPublish: boolean; blockers: readonly string[]; readyAssets: number }[];
  }[];
}): readonly OperatorChannelStatus[] {
  return report.channels.map((channel) => {
    const readyAssets = Math.max(0, ...channel.routes.map((route) => route.readyAssets), 0);
    if (channel.routes.some((route) => route.readyForAutonomousPublish)) {
      return { channelKey: channel.channelKey, qualified: true, readyAssets };
    }
    const blockers = [...new Set(channel.routes.flatMap((route) => route.blockers))];
    const withoutContent = blockers.filter((blocker) => blocker !== "no_ready_asset");
    if (withoutContent.length === 0) {
      return { channelKey: channel.channelKey, qualified: channel.routes.length > 0, readyAssets };
    }
    return {
      channelKey: channel.channelKey,
      qualified: false,
      reason: withoutContent.map(germanBlocker).join(", "),
      readyAssets
    };
  });
}

export interface OperatorPlanEntry {
  intentId: string;
  label: string;
  timeLocal: string;
  channelKey: string;
  /** Display name from the canonical spec -- what the operator calls this channel. */
  channelName: string;
  platform: string;
  state: PublicationState;
  /** Caption wording from the Drive file name -- the name Luca knows this video by. */
  videoLabel: string;
  /** Full caption as it will be posted, when it says more than the video name alone. */
  caption?: string;
  /** German reason for a BLOCKED entry -- only when the pipeline actually recorded one. */
  reason?: string;
  /** Live post URL once verification found it; the whole point of a checklist entry going green. */
  permalink?: string;
}

export interface OperatorBlockedAsset {
  label: string;
  reason?: string;
}

export interface OperatorPipelineSummary {
  observed: number;
  stabilizing: number;
  ready: number;
  blocked: number;
  blockedAssets: readonly OperatorBlockedAsset[];
}

/** A configured channel with nothing in today's plan, and the reason it has nothing. */
export interface OperatorChannelGap {
  channelKey: string;
  channelName: string;
  platform: string;
  /** German: "nicht freigegeben — Qualifikation fehlt", "kein Video im Drive-Ordner", ... */
  reason: string;
  badge: string;
  driveFolderUrl?: string;
}

export interface OperatorPlanView {
  businessDate: string;
  /** "Tagesplan Mi 2. Sep" -- the operator never reads an ISO business date. */
  planLabel: string;
  /** The next slot after this view's "now", when the day still has one. */
  nextSlot?: OperatorNextSlot;
  /** Instant of the day's last slot; the evening report waits for it. */
  lastSlotAt?: string;
  entries: readonly OperatorPlanEntry[];
  /** Every configured channel that has no post today, and why. */
  channelGaps: readonly OperatorChannelGap[];
  pipeline: OperatorPipelineSummary;
  disturbances: readonly Incident[];
  pauses: readonly SchedulePause[];
  killSwitches: readonly KillSwitch[];
}

/**
 * Qualification and repair runs write their own intents and lock owners ("qualification:...",
 * "headless-surface-replay:..."). Their failures are engineering evidence, not something the
 * operator can act on -- counting them is how one evening reported "13 weitere Störungen" for a
 * system that was posting normally.
 */
const QUALIFICATION_ORIGIN = /(?:^|[\s:|])(?:qualification|qualification-plan|qualification-delivery|qualification-verification|headless-surface-replay|headless-surface-discovery|surface-replay|private-e2e)[:-]/i;

export function isQualificationIncident(incident: Incident): boolean {
  return QUALIFICATION_ORIGIN.test([
    incident.scope.intentId ?? "",
    incident.fingerprint,
    incident.summary,
    ...Object.values(incident.metadata)
  ].join(" "));
}

/**
 * A disturbance the operator should see is OPEN, belongs to a channel the daemon runs today, and
 * did not come out of a qualification run. Everything else is engineering state and stays out of
 * the chat.
 */
export function isOperatorDisturbance(
  incident: Incident,
  scope: { accountIds: ReadonlySet<string>; todayIntentIds: ReadonlySet<string> }
): boolean {
  if (incident.status !== "OPEN") return false;
  if (isQualificationIncident(incident)) return false;
  if (incident.scope.intentId) return scope.todayIntentIds.has(incident.scope.intentId);
  if (incident.scope.accountId) return scope.accountIds.has(incident.scope.accountId);
  // A blocked Drive file has no account, but it is unmistakably this daemon's own operation.
  return Boolean(incident.scope.sourceObservationId);
}

const STATE_BADGE: Readonly<Record<PublicationState, string>> = {
  PLANNED: "⬜", READY: "⬜", SCHEDULED: "⬜",
  PREPARING: "▶️", PUBLISHING: "▶️", VERIFYING: "▶️",
  RETRY_WAIT: "⏳", PUBLISH_UNCERTAIN: "🛑", VERIFIED: "✅", BLOCKED: "⚠️", WAIVED: "➖"
};
const SEVERITY_BADGE: Readonly<Record<Incident["severity"], string>> = { INFO: "ℹ️", WARNING: "⚠️", ERROR: "🛑", CRITICAL: "🛑" };

function localTime(instant: string, timeZone: string): string {
  return new Intl.DateTimeFormat("de-AT", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(instant));
}

/**
 * Collects everything the operator's daily checklist and /plan command show: today's intents
 * named after their source video file, the Drive pipeline counters, open incidents, pauses and
 * kill switches. Pure read model -- collecting a view never mutates any store.
 */
export function collectOperatorPlanView(
  stores: OperatorPlanViewStores,
  channels: readonly OperatorChannelRef[],
  businessDate: string,
  timeZone: string,
  now?: string
): OperatorPlanView {
  const channelByAccount = new Map(channels.map((channel) => [channel.accountId, channel]));
  const assets = stores.state.listAssets();
  const assetByContent = new Map(assets.map((record) => [record.asset.contentId, record.asset]));
  const openIncidents = stores.control.listIncidents(["OPEN"]);
  // A BLOCKED entry is only useful with the reason the pipeline actually recorded. Nothing here
  // guesses: an unknown code produces no reason line at all.
  const reasonFor = (intentId: string, contentId: string, state: PublicationState): string | undefined => {
    if (state !== "BLOCKED") return undefined;
    const recorded = germanBlockReason(assetByContent.get(contentId)?.metadata.blockReason);
    if (recorded) return recorded;
    const incident = openIncidents.find((item) => item.scope.intentId === intentId);
    return incident ? germanIncident(incident.kind).meaning : undefined;
  };
  const entries = stores.control.listIntents()
    .filter((record) => businessDateForInstant(record.intent.scheduledFor, timeZone) === businessDate)
    .map((record) => {
      const reservation = stores.control.getReservationForIntent(record.intent.intentId);
      const channel = channelByAccount.get(record.intent.accountId);
      const filename = assetByContent.get(record.intent.contentId)?.filename;
      const parts = filename ? filenameParts(filename) : undefined;
      // No known asset means no known video; the operator gets a plain German gap, never an id.
      const videoLabel = parts?.text || filename || "Video unbekannt";
      const caption = parts?.hashtags ? `${parts.text} ${parts.hashtags}`.trim() : undefined;
      const reason = reasonFor(record.intent.intentId, record.intent.contentId, record.state);
      return {
        intentId: record.intent.intentId,
        label: filename ?? record.intent.contentId,
        videoLabel,
        timeLocal: localTime(reservation?.targetAt ?? record.intent.scheduledFor, timeZone),
        channelKey: channel?.key ?? record.intent.accountId,
        channelName: channel?.name ?? channel?.key ?? record.intent.accountId,
        platform: channel?.platform ?? record.intent.platform,
        state: record.state,
        ...(caption ? { caption } : {}),
        ...(reason ? { reason } : {}),
        ...(record.state === "VERIFIED" ? (() => { const permalink = stores.control.getVerifiedPublication?.(record.intent.intentId)?.permalink; return permalink ? { permalink } : {}; })() : {}),
        sortKey: reservation?.targetAt ?? record.intent.scheduledFor
      };
    })
    .sort((a, b) => a.sortKey.localeCompare(b.sortKey) || a.intentId.localeCompare(b.intentId));
  const upcoming = now ? entries.filter((entry) => entry.sortKey > now) : [];
  const nextSlot: OperatorNextSlot | undefined = upcoming[0]
    ? {
        timeLocal: upcoming[0].timeLocal,
        channelNames: [...new Set(upcoming.filter((entry) => entry.timeLocal === upcoming[0]!.timeLocal).map((entry) => entry.channelName))]
      }
    : undefined;
  const todayIntentIds = new Set(entries.map((entry) => entry.intentId));
  const accountIds = new Set(channels.map((channel) => channel.accountId));
  const disturbances = openIncidents.filter((incident) => isOperatorDisturbance(incident, { accountIds, todayIntentIds }));
  // Every configured channel appears, whether or not it has a slot today: a channel that is
  // silently missing from the plan looks like a channel that is fine.
  const status = new Map((stores.channelStatus?.() ?? []).map((item) => [item.channelKey, item]));
  const channelGaps: OperatorChannelGap[] = channels
    .filter((channel) => !entries.some((entry) => entry.channelKey === channel.key))
    .map((channel) => {
      const own = status.get(channel.key);
      const gap = own && !own.qualified
        ? { badge: "⏳", reason: `nicht freigegeben — ${own.reason ?? "Qualifikation fehlt"}` }
        : own && own.readyAssets === 0
          ? { badge: "⚠️", reason: "kein Video im Drive-Ordner" }
          : { badge: "➖", reason: "heute kein Post geplant" };
      return {
        channelKey: channel.key,
        channelName: channel.name,
        platform: channel.platform,
        ...gap,
        ...(channel.driveFolderUrl ? { driveFolderUrl: channel.driveFolderUrl } : {})
      };
    });
  const lastSlotAt = entries.at(-1)?.sortKey;
  const count = (state: string) => assets.filter((record) => record.asset.state === state).length;
  const pipeline: OperatorPipelineSummary = {
    observed: count("OBSERVED"),
    stabilizing: count("STABILIZING"),
    ready: count("READY"),
    blocked: count("BLOCKED"),
    blockedAssets: assets.filter((record) => record.asset.state === "BLOCKED").map((record) => {
      const reason = germanBlockReason(record.asset.metadata.blockReason);
      return { label: filenameParts(record.asset.filename).text || record.asset.filename, ...(reason ? { reason } : {}) };
    })
  };
  return {
    businessDate,
    planLabel: `Tagesplan ${germanDayLabel(businessDate)}`,
    ...(nextSlot ? { nextSlot } : {}),
    ...(lastSlotAt ? { lastSlotAt } : {}),
    entries: entries.map(({ sortKey: _sortKey, ...entry }) => entry),
    channelGaps,
    pipeline,
    disturbances,
    pauses: stores.pauses.listSchedulePauses(),
    killSwitches: stores.control.listKillSwitches(true)
  };
}

/**
 * The Drive counters as a person reads them: how many videos are usable, how many are not, how
 * many are still being checked. "0 beobachtet · 0 stabilisierend" was pipeline vocabulary that
 * meant nothing to the person who has to decide whether to upload something.
 */
export function describeDrivePipeline(pipeline: OperatorPipelineSummary): string {
  const [first] = pipeline.blockedAssets;
  const unusable = pipeline.blocked === 0 || !first
    ? `${pipeline.blocked} unbrauchbar`
    : `${pipeline.blocked} unbrauchbar („${first.label}“${first.reason ? ` — ${first.reason}` : ""})`;
  const videos = pipeline.ready === 1 ? "1 Video bereit" : `${pipeline.ready} Videos bereit`;
  return `📥 Drive: ${videos} · ${unusable} · ${pipeline.observed + pipeline.stabilizing} in Prüfung`;
}

/** The remaining unusable files, one indented line each; the first one is already inline above. */
function blockedAssetLines(pipeline: OperatorPipelineSummary): string[] {
  return pipeline.blockedAssets.slice(1, 5).map((asset) => `  ⚠️ „${asset.label}“${asset.reason ? ` — ${asset.reason}` : ""}`);
}

/** Suffix that says what a checklist row means, in the words the operator uses. */
function statusLabel(state: PublicationState): string | undefined {
  // The operator's part here is to leave it alone; the verify step belongs to the one message
  // that reports the uncertain click, not to a checklist row.
  if (state === "PUBLISH_UNCERTAIN") return "unsicher, eingefroren — wartet auf Prüfung von Hand";
  if (state === "VERIFIED" || state === "PLANNED" || state === "READY" || state === "SCHEDULED") return undefined;
  return germanState(state);
}

/** Names of the channels a pause or kill switch covers -- never their account ids. */
function scopeName(scopeKey: string, channels: readonly OperatorChannelRef[]): string {
  if (scopeKey === "*") return "ALLE Kanäle";
  const channel = channels.find((item) => item.accountId === scopeKey || item.key === scopeKey);
  return channel?.name ?? "ein Kanal";
}

/**
 * German, compact, emoji-status. The same text is the morning checklist and the /plan reply --
 * built from the shared operator context so it speaks exactly like every other message.
 */
export function renderOperatorPlan(view: OperatorPlanView, channels: readonly OperatorChannelRef[] = []): string {
  const entries: OperatorMessageContext[] = view.entries.map((entry): OperatorMessageContext => ({
    badge: STATE_BADGE[entry.state] ?? "⬜",
    slotLocal: entry.timeLocal,
    channelName: entry.channelName,
    platformLabel: germanPlatformLabel(entry.platform),
    videoLabel: entry.videoLabel,
    ...(entry.caption ? { caption: entry.caption } : {}),
    ...(statusLabel(entry.state) ? { statusLabel: statusLabel(entry.state)! } : {}),
    ...(entry.reason ? { reason: entry.reason } : {}),
    ...(entry.permalink ? { permalink: entry.permalink } : {})
  }));
  // Everything an unqualified or idle channel needs, in the same list as the real slots.
  entries.push(...view.channelGaps.map((gap) => ({
    badge: gap.badge,
    channelName: gap.channelName,
    platformLabel: germanPlatformLabel(gap.platform),
    statusLabel: gap.reason,
    ...(gap.driveFolderUrl ? { driveFolderUrl: gap.driveFolderUrl } : {})
  })));
  const pipeline = [describeDrivePipeline(view.pipeline), ...blockedAssetLines(view.pipeline)];
  const sections: { heading?: string; lines: string[] }[] = [{ lines: pipeline }];
  if (view.pauses.length > 0) {
    sections.push({ lines: [`⏸️ Pausiert: ${view.pauses.map((pause) => scopeName(pause.scopeKey, channels)).join(", ")}`] });
  }
  if (view.killSwitches.length > 0) {
    sections.push({ lines: [`🛑 Kill-Switch aktiv: ${view.killSwitches.map((item) => item.scopeType === "GLOBAL" ? "ALLE Kanäle" : scopeName(item.scopeKey, channels)).join(", ")} — Deaktivierung nur im Terminal`] });
  }
  if (view.disturbances.length > 0) {
    const lines = view.disturbances.slice(0, 8).map((incident) => `  ${SEVERITY_BADGE[incident.severity]} ${germanIncident(incident.kind).meaning}`);
    if (view.disturbances.length > 8) lines.push(`  … ${view.disturbances.length - 8} weitere`);
    sections.push({ heading: "⚠️ Störungen:", lines });
  }
  return operatorMessageText(renderOperatorMessage("PLAN", {
    planLabel: view.planLabel,
    ...(view.entries.length === 0 ? { headline: "Heute ist kein Post geplant." } : {}),
    entries,
    ...(view.nextSlot ? { nextSlot: view.nextSlot } : {}),
    sections
  }));
}
