import { createHash } from "node:crypto";
import type { OperatorChatStatePort } from "../domain/operator-ports.js";
import { businessDateForInstant } from "../domain/scheduling.js";
import { collectOperatorPlanView, renderOperatorPlan, type OperatorChannelRef, type OperatorPlanViewStores } from "./operator-plan-view.js";
import { germanDayLabel, germanState, operatorMessageText, renderOperatorMessage } from "./operator-message.js";

export interface OperatorMessengerPort {
  sendMessage(text: string): Promise<string>;
  editMessageText(messageId: string, text: string): Promise<void>;
}

export interface OperatorReportDeps {
  stores: OperatorPlanViewStores;
  channels: readonly OperatorChannelRef[];
  chatState: OperatorChatStatePort;
  messenger: OperatorMessengerPort;
}

export interface OperatorReportOptions {
  timeZone: string;
  /** Minute of local day from which the morning checklist exists (default 07:30). */
  morningMinuteLocal?: number;
  /** Minute of local day from which the evening (and Sunday weekly) report goes out (default 20:30). */
  eveningMinuteLocal?: number;
  clock?: () => string;
}

export interface OperatorReportTickResult {
  checklistSent: boolean;
  checklistEdited: boolean;
  eveningSent: boolean;
  weeklySent: boolean;
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function localParts(now: string, timeZone: string): { businessDate: string; minuteOfDay: number; weekday: string } {
  const date = new Date(now);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid instant: ${now}`);
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short" });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    businessDate: `${parts.year}-${parts.month}-${parts.day}`,
    minuteOfDay: Number(parts.hour) * 60 + Number(parts.minute),
    weekday: parts.weekday ?? ""
  };
}

function minusDays(businessDate: string, days: number): string {
  const date = new Date(`${businessDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

/**
 * The operator's report rhythm as one idempotent daemon-cycle step:
 * - morning: the day's checklist message goes out once and its message id is persisted;
 * - every later tick: the checklist is re-rendered and edited in place the moment a post turns
 *   VERIFIED or the pipeline/disturbance picture changes (hash-guarded, no spam);
 * - evening: one German result summary; Sundays additionally one weekly summary.
 * Marks are set only after a successful send, so a failed Telegram call retries next cycle.
 */
export class OperatorReportService {
  private readonly clock: () => string;
  private readonly morningMinuteLocal: number;
  private readonly eveningMinuteLocal: number;

  constructor(private readonly deps: OperatorReportDeps, private readonly options: OperatorReportOptions) {
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.morningMinuteLocal = options.morningMinuteLocal ?? 7 * 60 + 30;
    this.eveningMinuteLocal = options.eveningMinuteLocal ?? 20 * 60 + 30;
  }

  async tick(now = this.clock()): Promise<OperatorReportTickResult> {
    const result: OperatorReportTickResult = { checklistSent: false, checklistEdited: false, eveningSent: false, weeklySent: false };
    const local = localParts(now, this.options.timeZone);
    if (local.minuteOfDay >= this.morningMinuteLocal) {
      const text = renderOperatorPlan(collectOperatorPlanView(this.deps.stores, this.deps.channels, local.businessDate, this.options.timeZone, now), this.deps.channels);
      const contentHash = hashText(text);
      const existing = this.deps.chatState.getChecklistMessage(local.businessDate);
      if (!existing) {
        const chatMessageId = await this.deps.messenger.sendMessage(text);
        this.deps.chatState.putChecklistMessage({ businessDate: local.businessDate, chatMessageId, contentHash, updatedAt: now });
        result.checklistSent = true;
      } else if (existing.contentHash !== contentHash) {
        await this.deps.messenger.editMessageText(existing.chatMessageId, text);
        this.deps.chatState.putChecklistMessage({ businessDate: local.businessDate, chatMessageId: existing.chatMessageId, contentHash, updatedAt: now });
        result.checklistEdited = true;
      }
    }
    if (local.minuteOfDay >= this.eveningMinuteLocal) {
      const eveningKey = `abend:${local.businessDate}`;
      if (!this.deps.chatState.wasOperatorEventSent(eveningKey)) {
        await this.deps.messenger.sendMessage(this.eveningText(local.businessDate));
        this.deps.chatState.markOperatorEventSent(eveningKey, now);
        result.eveningSent = true;
      }
      const weeklyKey = `woche:${local.businessDate}`;
      if (local.weekday === "Sun" && !this.deps.chatState.wasOperatorEventSent(weeklyKey)) {
        await this.deps.messenger.sendMessage(this.weeklyText(local.businessDate));
        this.deps.chatState.markOperatorEventSent(weeklyKey, now);
        result.weeklySent = true;
      }
    }
    return result;
  }

  private eveningText(businessDate: string): string {
    const view = collectOperatorPlanView(this.deps.stores, this.deps.channels, businessDate, this.options.timeZone);
    const count = (state: string) => view.entries.filter((entry) => entry.state === state).length;
    const verified = count("VERIFIED");
    const complete = view.entries.length > 0 && verified + count("WAIVED") === view.entries.length;
    const lines = [
      `✅ ${verified}/${view.entries.length} verifiziert · ➖ ${count("WAIVED")} übersprungen`,
      `⚠️ ${count("BLOCKED")} blockiert · 🛑 ${count("PUBLISH_UNCERTAIN")} unsicher`,
      `Offene Störungen: ${view.disturbances.length}`
    ];
    // A finished day is only worth reading with the live links; an unfinished one with the
    // channel and video that still owe something.
    const published = view.entries
      .filter((entry) => entry.state === "VERIFIED")
      .flatMap((entry) => [`✅ ${entry.channelName} · „${entry.videoLabel}“`, ...(entry.permalink ? [entry.permalink] : [])]);
    const open = view.entries
      .filter((entry) => entry.state !== "VERIFIED" && entry.state !== "WAIVED")
      .slice(0, 6)
      .map((entry) => `${entry.state === "PUBLISH_UNCERTAIN" ? "🛑" : "⚠️"} ${entry.channelName} · „${entry.videoLabel}“ · ${germanState(entry.state)}${entry.reason ? ` — ${entry.reason}` : ""}`);
    return operatorMessageText(renderOperatorMessage("DAY_END", {
      planLabel: germanDayLabel(businessDate),
      ok: complete,
      lines,
      sections: [
        ...(published.length > 0 ? [{ heading: "Heute veröffentlicht:", lines: published }] : []),
        ...(open.length > 0 ? [{ heading: "Offen:", lines: open }] : [])
      ]
    }));
  }

  private weeklyText(businessDate: string): string {
    const since = minusDays(businessDate, 6);
    const channelByAccount = new Map(this.deps.channels.map((channel) => [channel.accountId, channel]));
    const week = this.deps.stores.control.listIntents().filter((record) => {
      const date = businessDateForInstant(record.intent.scheduledFor, this.options.timeZone);
      return date >= since && date <= businessDate;
    });
    const count = (state: string) => week.filter((record) => record.state === state).length;
    const lines = [
      `✅ ${count("VERIFIED")} verifiziert · ⚠️ ${count("BLOCKED")} blockiert · 🛑 ${count("PUBLISH_UNCERTAIN")} unsicher · ➖ ${count("WAIVED")} übersprungen`
    ];
    const perChannel: string[] = [];
    for (const channel of this.deps.channels) {
      const mine = week.filter((record) => record.intent.accountId === channel.accountId);
      if (mine.length === 0) continue;
      perChannel.push(`${channel.name}: ${mine.filter((record) => record.state === "VERIFIED").length}/${mine.length} verifiziert`);
    }
    const unknown = week.filter((record) => !channelByAccount.has(record.intent.accountId)).length;
    if (unknown > 0) perChannel.push(`ℹ️ ${unknown} Posts außerhalb der konfigurierten Kanäle`);
    return operatorMessageText(renderOperatorMessage("WEEK_REPORT", {
      planLabel: `${germanDayLabel(since)} – ${germanDayLabel(businessDate)}`,
      lines,
      ...(perChannel.length > 0 ? { sections: [{ heading: "Pro Kanal:", lines: perChannel }] } : {})
    }));
  }
}
