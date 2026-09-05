import type { StoredBrowserIdentity, SessionHealthCheck } from "../domain/browser-identity.js";
import type { KillSwitch, KillSwitchScopeType } from "../domain/operations.js";
import type { SchedulePauseStorePort } from "../domain/operator-ports.js";
import type { HeadlessDoctorReport } from "./headless-status.js";
import type { ScheduleCommandService, ScheduleTargetView } from "./schedule-commands.js";
import { businessDateForInstant } from "../domain/scheduling.js";
import { collectOperatorPlanView, describeDrivePipeline, renderOperatorPlan, type OperatorChannelRef, type OperatorPlanViewStores } from "./operator-plan-view.js";
import { customerAwareChannels, customerAwarePlanView, customerChannelLabel, resolveCustomer, summarizeCustomers } from "./customer-operator-view.js";
import { germanBlocker, germanDayLabel, germanDoctorCheck, germanPlatformLabel, germanState, operatorMessageText, renderOperatorMessage } from "./operator-message.js";

export interface OperatorCommandControlReads {
  listBrowserIdentities(): readonly StoredBrowserIdentity[];
  latestSessionHealth(identityId: string): SessionHealthCheck | null;
}

export interface OperatorKillSwitchWriter {
  set(scopeType: KillSwitchScopeType, scopeKey: string, enabled: boolean, reason: string, at: string, operatorId: string): KillSwitch;
}

export interface OperatorCommandDeps {
  channels: readonly OperatorChannelRef[];
  stores: OperatorPlanViewStores & { control: OperatorPlanViewStores["control"] & OperatorCommandControlReads };
  pauses: SchedulePauseStorePort;
  killSwitches: OperatorKillSwitchWriter;
  doctor: () => HeadlessDoctorReport;
  /** Same canonical schedule service the CLI uses; absent means this installation is read-only. */
  scheduleCommands?: Pick<ScheduleCommandService, "show" | "add" | "remove" | "capacity">;
  timeZone: string;
  clock?: () => string;
  operatorId?: string;
}

const SESSION_BADGE: Readonly<Record<string, string>> = {
  HEALTHY: "✅", AUTH_REQUIRED: "🛑", CHALLENGE: "🛑", IDENTITY_MISMATCH: "🛑", UNREACHABLE: "⚠️", UNKNOWN: "⚠️", MISSING: "⚠️"
};
const DOCTOR_BADGE: Readonly<Record<string, string>> = { PASS: "✅", WARN: "⚠️", FAIL: "🛑" };

const HELP_TEXT = [
  "ℹ️ Flerdvision Operator-Befehle:",
  "/status — Kanäle, Sessions, heutiger Stand",
  "/plan — Tagesplan mit Checkliste",
  "/kunden — kompakter Stand pro Kunde",
  "/kunde <name> — ein Kunde mit Zeiten und heutigem Plan",
  "/zeitplan — feste Posting-Zeiten anzeigen",
  "/slot <kanal> + <HH:mm> — Slot hinzufügen",
  "/slot <kanal> - <HH:mm> — Slot entfernen",
  "/limit <kanal> <anzahl> — Anzahl Tages-Slots erhöhen",
  "/doctor — Readiness-Prüfung",
  "/pause <kanal|alle> — Zeitplan pausieren",
  "/fortsetzen <kanal|alle> — Zeitplan fortsetzen",
  "/stopp <kanal|alle> — Kill-Switch AKTIVIEREN (Not-Aus)",
  "",
  "Zeitplan-Befehle ändern nur die kanonische Planung; bereits materialisierte heutige Posts bleiben aus Sicherheitsgründen bestehen. /pause stoppt fällige Posts sofort.",
  "Der Bot gibt keinen Publish frei. Kill-Switch deaktivieren geht nur im Terminal."
].join("\n");

/**
 * Executes the operator's chat commands against the persisted stores and answers in compact
 * German. Schedule edits, when configured, go through the exact same ScheduleCommandService as
 * the CLI. Kill switches remain ENABLE ONLY from chat. The service can neither publish, approve,
 * resume PUBLISH_UNCERTAIN, nor touch qualification/evidence state.
 */
export class OperatorCommandService {
  private readonly clock: () => string;
  private readonly operatorId: string;

  constructor(private readonly deps: OperatorCommandDeps) {
    this.clock = deps.clock ?? (() => new Date().toISOString());
    this.operatorId = deps.operatorId ?? "telegram-operator";
  }

  async execute(text: string): Promise<string> {
    const tokens = text.trim().split(/\s+/);
    const command = (tokens[0] ?? "").toLocaleLowerCase("en-US").replace(/@\S+$/, "");
    const argument = tokens[1]?.trim();
    switch (command) {
      case "/start": case "/hilfe": case "/help": return HELP_TEXT;
      case "/status": return this.status();
      case "/plan": return this.plan();
      case "/kunden": return this.customers();
      case "/kunde": return this.customer(tokens.slice(1).join(" "));
      case "/zeitplan": return this.schedule();
      case "/slot": return await this.slot(tokens.slice(1));
      case "/limit": return await this.limit(tokens.slice(1));
      case "/doctor": return this.doctor();
      case "/pause": return this.pause(argument);
      case "/fortsetzen": return this.resume(argument);
      case "/stopp": return this.stop(argument);
      default: return `ℹ️ Unbekannter Befehl. ${HELP_TEXT}`;
    }
  }

  private today(): string { return businessDateForInstant(this.clock(), this.deps.timeZone); }

  /** Business projection only. A broken optional customer view never changes operational state. */
  private scheduleViews(): readonly ScheduleTargetView[] {
    if (!this.deps.scheduleCommands) return [];
    try { return this.deps.scheduleCommands.show(); }
    catch { return []; }
  }

  private rawPlan() {
    return collectOperatorPlanView(this.deps.stores, this.deps.channels, this.today(), this.deps.timeZone, this.clock());
  }

  private resolveScope(argument: string | undefined, verb: string): { scopeKey: string; channelKey: string; label: string } | string {
    if (!argument) return `⚠️ Kanal fehlt. ${verb} <kanal>. Verfügbar: ${this.channelList()}`;
    const normalized = argument.toLocaleLowerCase("en-US");
    if (normalized === "alle" || normalized === "*") return { scopeKey: "*", channelKey: "alle", label: "ALLE Kanäle" };
    const short = (key: string) => key.toLocaleLowerCase("en-US").replace(/^(instagram|tiktok|youtube)-/, "");
    const matches = this.deps.channels.filter((item) =>
      item.key.toLocaleLowerCase("en-US") === normalized || short(item.key) === normalized || item.name.toLocaleLowerCase("en-US") === normalized);
    if (matches.length > 1) return `⚠️ „${argument}“ ist mehrdeutig. Verfügbar: ${this.channelList()}`;
    const channel = matches[0];
    if (!channel) return `⚠️ Unbekannter Kanal „${argument}“. Verfügbar: ${this.channelList()}`;
    return {
      scopeKey: channel.accountId,
      channelKey: channel.key,
      label: `${customerChannelLabel(channel.key, channel.name, this.scheduleViews())} (${germanPlatformLabel(channel.platform)})`
    };
  }

  private channelList(): string {
    const views = this.scheduleViews();
    return `${this.deps.channels.map((channel) => `${customerChannelLabel(channel.key, channel.name, views)} (${channel.key})`).join(", ")}, alle`;
  }

  private status(): string {
    const scheduleViews = this.scheduleViews();
    const view = customerAwarePlanView(this.rawPlan(), scheduleViews);
    const identities = this.deps.stores.control.listBrowserIdentities();
    const lines: string[] = [];
    for (const channel of this.deps.channels) {
      const identity = identities.find((item) => item.identity.accountId === channel.accountId);
      const health = identity ? this.deps.stores.control.latestSessionHealth(identity.identity.identityId) : null;
      const state = health?.state ?? "MISSING";
      const paused = view.pauses.some((pause) => pause.scopeKey === "*" || pause.scopeKey === channel.accountId);
      const stopped = view.killSwitches.some((item) =>
        item.scopeType === "GLOBAL" || (item.scopeType === "ACCOUNT" && item.scopeKey === channel.accountId) || (item.scopeType === "PLATFORM" && item.scopeKey === channel.platform));
      const label = customerChannelLabel(channel.key, channel.name, scheduleViews);
      lines.push(`${SESSION_BADGE[state] ?? "⚠️"} ${label} (${germanPlatformLabel(channel.platform)}) · ${germanState(state)}${paused ? " · ⏸️ pausiert" : ""}${stopped ? " · 🛑 Kill-Switch" : ""}`);
    }
    const verified = view.entries.filter((entry) => entry.state === "VERIFIED").length;
    const blocked = view.entries.filter((entry) => entry.state === "BLOCKED").length;
    const uncertain = view.entries.filter((entry) => entry.state === "PUBLISH_UNCERTAIN").length;
    lines.push(`Heute: ${verified} von ${view.entries.length} geplanten Posts sind live · ${blocked} blockiert · ${uncertain} unsicher`);
    if (view.disturbances.length > 0) lines.push(`Offene Störungen: ${view.disturbances.length}`);
    lines.push(describeDrivePipeline(view.pipeline));
    if (uncertain > 0) lines.push("🛑 Unsichere Posts sind eingefroren — sie warten auf eine Prüfung von Hand.");
    return operatorMessageText(renderOperatorMessage("STATUS", {
      planLabel: germanDayLabel(this.today()),
      lines,
      ...(view.nextSlot ? { nextSlot: view.nextSlot } : {})
    }));
  }

  private plan(): string {
    const scheduleViews = this.scheduleViews();
    return renderOperatorPlan(
      customerAwarePlanView(this.rawPlan(), scheduleViews),
      customerAwareChannels(this.deps.channels, scheduleViews)
    );
  }

  private customers(): string {
    if (!this.deps.scheduleCommands) return "⚠️ Kundenansicht ist in dieser Installation nicht verbunden.";
    try {
      const views = this.deps.scheduleCommands.show();
      const summaries = summarizeCustomers(this.rawPlan(), views);
      if (summaries.length === 0) return "👥 Kunden\nKeine Kunden konfiguriert.";
      const lines = summaries.map((item) => {
        const badge = item.uncertain > 0 ? "🛑" : item.blocked > 0 || item.gaps > 0 ? "⚠️" : item.planned > 0 && item.verified === item.planned ? "✅" : "⬜";
        return `${badge} ${item.customerName} · ${item.channelKeys.length} Kanäle · ${item.verified}/${item.planned} live · ${item.blocked} blockiert · ${item.gaps} ohne Post`;
      });
      return ["👥 Kunden", ...lines, "", "Details: /kunde <name>"].join("\n");
    } catch (error) {
      return `⚠️ Kundenansicht nicht verfügbar: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private customer(query: string): string {
    if (!this.deps.scheduleCommands) return "⚠️ Kundenansicht ist in dieser Installation nicht verbunden.";
    if (!query.trim()) return "⚠️ Verwendung: /kunde <name>";
    try {
      const views = this.deps.scheduleCommands.show();
      const customer = resolveCustomer(query, views);
      if (!customer) {
        const names = [...new Set(views.map((item) => item.customerName))].join(", ");
        return `⚠️ Unbekannter Kunde „${query}“. Verfügbar: ${names || "keine"}`;
      }
      const ownSchedule = views.filter((item) => item.customerKey === customer.customerKey);
      const channelKeys = new Set(ownSchedule.map((item) => item.channelKey));
      const raw = this.rawPlan();
      const entries = raw.entries.filter((entry) => channelKeys.has(entry.channelKey));
      const gaps = raw.channelGaps.filter((gap) => channelKeys.has(gap.channelKey));
      const summary = summarizeCustomers(raw, views).find((item) => item.customerKey === customer.customerKey);
      const lines = [`👤 ${customer.customerName}`];
      for (const item of ownSchedule) {
        lines.push(`• ${item.channelName} · ${item.format} · ${item.times.join(", ")} (${item.capacity}/Tag)`);
      }
      lines.push("");
      lines.push(`Heute: ${summary?.verified ?? 0}/${summary?.planned ?? 0} live · ${summary?.blocked ?? 0} blockiert · ${summary?.uncertain ?? 0} unsicher`);
      for (const entry of entries) {
        const badge = entry.state === "VERIFIED" ? "✅" : entry.state === "PUBLISH_UNCERTAIN" ? "🛑" : entry.state === "BLOCKED" ? "⚠️" : "⬜";
        lines.push(`${badge} ${entry.timeLocal} · ${entry.channelName} · „${entry.videoLabel}“${entry.reason ? ` — ${entry.reason}` : ""}`);
      }
      for (const gap of gaps) lines.push(`${gap.badge} ${gap.channelName} · ${gap.reason}`);
      return lines.join("\n");
    } catch (error) {
      return `⚠️ Kunde konnte nicht gelesen werden: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private schedule(): string {
    if (!this.deps.scheduleCommands) return "⚠️ Zeitplan-Änderungen sind in dieser Installation nicht verbunden.";
    try {
      const views = this.deps.scheduleCommands.show();
      const lines = views.map((item) => `• ${item.customerName} · ${item.channelName} · ${item.format}: ${item.times.join(", ")} (${item.capacity}/Tag)`);
      return ["🗓️ Zeitplan", ...lines, "", "Ändern: /slot <kanal> +|- <HH:mm> · /limit <kanal> <anzahl>"].join("\n");
    } catch (error) {
      return `⚠️ Zeitplan konnte nicht gelesen werden: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private async slot(args: readonly string[]): Promise<string> {
    if (!this.deps.scheduleCommands) return "⚠️ Zeitplan-Änderungen sind in dieser Installation nicht verbunden.";
    if (args.length !== 3 || (args[1] !== "+" && args[1] !== "-")) return "⚠️ Verwendung: /slot <kanal[/format]> +|- <HH:mm>";
    try {
      const result = args[1] === "+"
        ? await this.deps.scheduleCommands.add(args[0]!, args[2]!)
        : await this.deps.scheduleCommands.remove(args[0]!, args[2]!);
      return [
        `✅ Zeitplan aktualisiert: ${result.customerName} · ${result.channelName} · ${result.format}`,
        `Slots: ${result.times.join(", ")}`,
        "Bereits materialisierte heutige Posts bleiben bestehen. /pause stoppt fällige Posts sofort."
      ].join("\n");
    } catch (error) {
      return `⚠️ Zeitplan nicht geändert: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private async limit(args: readonly string[]): Promise<string> {
    if (!this.deps.scheduleCommands) return "⚠️ Zeitplan-Änderungen sind in dieser Installation nicht verbunden.";
    if (args.length !== 2) return "⚠️ Verwendung: /limit <kanal[/format]> <anzahl>";
    const desired = Number(args[1]);
    if (!Number.isInteger(desired)) return "⚠️ Die Anzahl muss eine ganze Zahl sein.";
    try {
      const result = await this.deps.scheduleCommands.capacity(args[0]!, desired);
      return [
        `✅ Kapazität aktualisiert: ${result.customerName} · ${result.channelName} · ${result.capacity} Slots/Tag`,
        `Slots: ${result.times.join(", ")}`,
        "Zum Verkleinern Slots bewusst mit /slot ... - ... entfernen."
      ].join("\n");
    } catch (error) {
      return `⚠️ Kapazität nicht geändert: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private doctor(): string {
    let report: HeadlessDoctorReport;
    try { report = this.deps.doctor(); }
    catch (error) { return `🛑 Doctor fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`; }
    const scheduleViews = this.scheduleViews();
    const lines = [`Release ${report.releaseSha}`];
    for (const check of report.checks.filter((item) => item.status !== "PASS").slice(0, 10)) {
      lines.push(`${DOCTOR_BADGE[check.status] ?? "⚠️"} ${germanDoctorCheck(check.key)}: ${germanState(check.status)}`);
    }
    const channels = report.channels.map((channel) => {
      const named = this.deps.channels.find((item) => item.key === channel.channelKey);
      const ready = channel.routes.filter((route) => route.readyForAutonomousPublish).length;
      const blockers = [...new Set(channel.routes.flatMap((route) => route.blockers))].map(germanBlocker);
      const ok = ready === channel.routes.length && channel.routes.length > 0;
      const label = named ? customerChannelLabel(named.key, named.name, scheduleViews) : channel.channelKey;
      return `${ok ? "✅" : "⚠️"} ${label} · ${germanState(channel.latestSessionState)} · ${ready}/${channel.routes.length} Routen bereit${ok || blockers.length === 0 ? "" : ` — ${blockers.join(", ")}`}`;
    });
    return operatorMessageText(renderOperatorMessage("DOCTOR", {
      badge: DOCTOR_BADGE[report.overall] ?? "⚠️",
      statusLabel: germanState(report.overall),
      lines,
      ...(channels.length > 0 ? { sections: [{ heading: "Kanäle:", lines: channels }] } : {})
    }));
  }

  private pause(argument: string | undefined): string {
    const scope = this.resolveScope(argument, "/pause");
    if (typeof scope === "string") return scope;
    this.deps.pauses.setSchedulePause({ scopeKey: scope.scopeKey, channelKey: scope.channelKey, reason: "operator_pause", pausedAt: this.clock(), pausedBy: this.operatorId });
    return operatorMessageText(renderOperatorMessage("SWITCH", {
      badge: "⏸️", headline: `${scope.label} pausiert`,
      reason: "Fällige Posts bleiben geplant und werden nicht verbraucht.",
      nextStep: `/fortsetzen ${scope.channelKey}`
    }));
  }

  private resume(argument: string | undefined): string {
    const scope = this.resolveScope(argument, "/fortsetzen");
    if (typeof scope === "string") return scope;
    const cleared = this.deps.pauses.clearSchedulePause(scope.scopeKey);
    if (!cleared) return `ℹ️ ${scope.label} war nicht pausiert.`;
    const stillStopped = this.deps.stores.control.listKillSwitches(true).length > 0;
    return operatorMessageText(renderOperatorMessage("SWITCH", {
      badge: "▶️", headline: `${scope.label} fortgesetzt`,
      ...(stillStopped ? { reason: "⚠️ Achtung: Kill-Switch weiterhin aktiv — Deaktivierung nur im Terminal." } : {})
    }));
  }

  private stop(argument: string | undefined): string {
    const scope = this.resolveScope(argument, "/stopp");
    if (typeof scope === "string") return scope;
    const scopeType: KillSwitchScopeType = scope.scopeKey === "*" ? "GLOBAL" : "ACCOUNT";
    this.deps.killSwitches.set(scopeType, scope.scopeKey, true, `telegram_stopp:${scope.channelKey}`, this.clock(), this.operatorId);
    return operatorMessageText(renderOperatorMessage("SWITCH", {
      badge: "🛑", headline: `Kill-Switch AKTIVIERT für ${scope.label}`,
      reason: "Es wird nichts mehr veröffentlicht.",
      nextStep: "Deaktivieren geht nur im Terminal, nicht über den Chat."
    }));
  }
}
