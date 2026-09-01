import type { StoredPublicationIntent, ScheduleReservation } from "../domain/control-plane.js";
import type { StoredContentAssetRevision } from "../domain/distribution-runtime-ports.js";
import type { Incident, KillSwitch } from "../domain/operations.js";
import type { SchedulePause } from "../domain/operator-ports.js";
import type { PublicationState } from "../domain/states.js";
import { businessDateForInstant } from "../domain/scheduling.js";

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
  /** Live post URL once verification found it; the whole point of a checklist entry going green. */
  permalink?: string;
}

export interface OperatorPipelineSummary {
  observed: number;
  stabilizing: number;
  ready: number;
  blocked: number;
  blockedLabels: readonly string[];
}

export interface OperatorPlanView {
  businessDate: string;
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
  timeZone: string
): OperatorPlanView {
  const channelByAccount = new Map(channels.map((channel) => [channel.accountId, channel]));
  const assets = stores.state.listAssets();
  const labelByContent = new Map(assets.map((record) => [record.asset.contentId, record.asset.filename]));
  const entries = stores.control.listIntents()
    .filter((record) => businessDateForInstant(record.intent.scheduledFor, timeZone) === businessDate)
    .map((record) => {
      const reservation = stores.control.getReservationForIntent(record.intent.intentId);
      const channel = channelByAccount.get(record.intent.accountId);
      return {
        intentId: record.intent.intentId,
        label: labelByContent.get(record.intent.contentId) ?? record.intent.contentId,
        timeLocal: localTime(reservation?.targetAt ?? record.intent.scheduledFor, timeZone),
        channelKey: channel?.key ?? record.intent.accountId,
        channelName: channel?.name ?? channel?.key ?? record.intent.accountId,
        platform: channel?.platform ?? record.intent.platform,
        state: record.state,
        ...(record.state === "VERIFIED" ? (() => { const permalink = stores.control.getVerifiedPublication?.(record.intent.intentId)?.permalink; return permalink ? { permalink } : {}; })() : {}),
        sortKey: reservation?.targetAt ?? record.intent.scheduledFor
      };
    })
    .sort((a, b) => a.sortKey.localeCompare(b.sortKey) || a.intentId.localeCompare(b.intentId))
    .map(({ sortKey: _sortKey, ...entry }) => entry);
  const count = (state: string) => assets.filter((record) => record.asset.state === state).length;
  const pipeline: OperatorPipelineSummary = {
    observed: count("OBSERVED"),
    stabilizing: count("STABILIZING"),
    ready: count("READY"),
    blocked: count("BLOCKED"),
    blockedLabels: assets.filter((record) => record.asset.state === "BLOCKED").map((record) => record.asset.filename)
  };
  return {
    businessDate,
    entries,
    pipeline,
    disturbances: stores.control.listIncidents(["OPEN", "ACKNOWLEDGED"]),
    pauses: stores.pauses.listSchedulePauses(),
    killSwitches: stores.control.listKillSwitches(true)
  };
}

/** German, compact, emoji-status. The same text is the morning checklist and the /plan reply. */
const PLATFORM_LABEL: Readonly<Record<string, string>> = { instagram: "Instagram", tiktok: "TikTok", youtube: "YouTube" };

export function renderOperatorPlan(view: OperatorPlanView): string {
  const lines: string[] = [`📋 Tagesplan ${view.businessDate}`];
  if (view.entries.length === 0) lines.push("Keine Posts geplant.");
  for (const entry of view.entries) {
    const badge = STATE_BADGE[entry.state] ?? "⬜";
    // The operator reads channel NAMES, not spec keys, and a finished post is only useful with
    // the link to it -- a checklist that goes green without one says nothing you can act on.
    const platform = PLATFORM_LABEL[entry.platform] ?? entry.platform;
    const suffix = entry.state === "PUBLISH_UNCERTAIN"
      ? " · unsicher, eingefroren (verify im Terminal)"
      : entry.state === "BLOCKED" ? " · blockiert" : "";
    const link = entry.permalink ? `\n     ${entry.permalink}` : "";
    lines.push(`${badge} ${entry.timeLocal} · ${entry.channelName} (${platform}) · ${entry.label}${suffix}${link}`);
  }
  lines.push("", `📥 Drive-Pipeline: ${view.pipeline.observed} neu · ${view.pipeline.stabilizing} stabilisierend · ${view.pipeline.ready} READY · ${view.pipeline.blocked} blockiert`);
  for (const label of view.pipeline.blockedLabels.slice(0, 5)) lines.push(`  ⚠️ blockiert: ${label}`);
  if (view.pauses.length > 0) lines.push("", `⏸️ Pausiert: ${view.pauses.map((pause) => `${pause.channelKey} (${pause.reason})`).join(", ")}`);
  if (view.killSwitches.length > 0) lines.push("", `🛑 Kill-Switch aktiv: ${view.killSwitches.map((item) => item.scopeType === "GLOBAL" ? "ALLE" : item.scopeKey).join(", ")} — Deaktivierung nur im Terminal`);
  if (view.disturbances.length > 0) {
    lines.push("", "⚠️ Störungen:");
    for (const incident of view.disturbances.slice(0, 8)) lines.push(`  ${SEVERITY_BADGE[incident.severity]} ${incident.title}`);
    if (view.disturbances.length > 8) lines.push(`  … ${view.disturbances.length - 8} weitere`);
  }
  return lines.join("\n").slice(0, 4000);
}
