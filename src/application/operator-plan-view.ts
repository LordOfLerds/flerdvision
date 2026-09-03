import type { StoredPublicationIntent, ScheduleReservation } from "../domain/control-plane.js";
import type { StoredContentAssetRevision } from "../domain/distribution-runtime-ports.js";
import type { Incident, KillSwitch } from "../domain/operations.js";
import type { SchedulePause } from "../domain/operator-ports.js";
import type { PublicationState } from "../domain/states.js";
import { businessDateForInstant } from "../domain/scheduling.js";
import { filenameParts } from "../adapters/publish/workspace-payload-resolver.js";
import {
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

export interface OperatorPlanView {
  businessDate: string;
  /** "Tagesplan Mi 2. Sep" -- the operator never reads an ISO business date. */
  planLabel: string;
  /** The next slot after this view's "now", when the day still has one. */
  nextSlot?: OperatorNextSlot;
  entries: readonly OperatorPlanEntry[];
  pipeline: OperatorPipelineSummary;
  disturbances: readonly Incident[];
  pauses: readonly SchedulePause[];
  killSwitches: readonly KillSwitch[];
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
  const disturbances = stores.control.listIncidents(["OPEN", "ACKNOWLEDGED"]);
  // A BLOCKED entry is only useful with the reason the pipeline actually recorded. Nothing here
  // guesses: an unknown code produces no reason line at all.
  const reasonFor = (intentId: string, contentId: string, state: PublicationState): string | undefined => {
    if (state !== "BLOCKED") return undefined;
    const recorded = germanBlockReason(assetByContent.get(contentId)?.metadata.blockReason);
    if (recorded) return recorded;
    const incident = disturbances.find((item) => item.scope.intentId === intentId);
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
    entries: entries.map(({ sortKey: _sortKey, ...entry }) => entry),
    pipeline,
    disturbances,
    pauses: stores.pauses.listSchedulePauses(),
    killSwitches: stores.control.listKillSwitches(true)
  };
}

/** Suffix that says what a checklist row means, in the words the operator uses. */
function statusLabel(state: PublicationState): string | undefined {
  if (state === "PUBLISH_UNCERTAIN") return "unsicher, eingefroren (verify im Terminal)";
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
  const entries: OperatorMessageContext[] = view.entries.map((entry) => ({
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
  const pipeline = [
    `📥 Drive: ${view.pipeline.observed} beobachtet · ${view.pipeline.stabilizing} stabilisierend · ${view.pipeline.ready} bereit · ${view.pipeline.blocked} blockiert`,
    ...view.pipeline.blockedAssets.slice(0, 5).map((asset) => `  ⚠️ blockiert: „${asset.label}“${asset.reason ? ` — ${asset.reason}` : ""}`)
  ];
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
    entries,
    ...(view.nextSlot ? { nextSlot: view.nextSlot } : {}),
    sections
  }));
}
