import type { StoredBrowserIdentity, SessionHealthCheck } from "../domain/browser-identity.js";
import type { KillSwitch, KillSwitchScopeType } from "../domain/operations.js";
import type { SchedulePauseStorePort } from "../domain/operator-ports.js";
import type { HeadlessDoctorReport } from "./headless-status.js";
import { businessDateForInstant } from "../domain/scheduling.js";
import { collectOperatorPlanView, renderOperatorPlan, type OperatorChannelRef, type OperatorPlanViewStores } from "./operator-plan-view.js";
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
  "/doctor — Readiness-Prüfung",
  "/pause <kanal|alle> — Zeitplan pausieren",
  "/fortsetzen <kanal|alle> — Zeitplan fortsetzen",
  "/stopp <kanal|alle> — Kill-Switch AKTIVIEREN (Not-Aus)",
  "",
  "Der Bot postet nie und gibt nichts frei. Kill-Switch deaktivieren geht nur im Terminal."
].join("\n");

/**
 * Executes the operator's chat commands against the persisted stores and answers in compact
 * German. Strictly read-only except for two reversible-by-design writes: schedule pauses
 * (both directions) and kill switches (ENABLE ONLY -- disabling a kill switch from chat is
 * forbidden by decision 2026-08-30 and has no code path here). The service can neither publish,
 * approve, resume PUBLISH_UNCERTAIN, nor touch qualification/evidence state.
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
      case "/doctor": return this.doctor();
      case "/pause": return this.pause(argument);
      case "/fortsetzen": return this.resume(argument);
      case "/stopp": return this.stop(argument);
      default: return `ℹ️ Unbekannter Befehl. ${HELP_TEXT}`;
    }
  }

  private today(): string { return businessDateForInstant(this.clock(), this.deps.timeZone); }

  private resolveScope(argument: string | undefined, verb: string): { scopeKey: string; channelKey: string; label: string } | string {
    if (!argument) return `⚠️ Kanal fehlt. ${verb} <kanal>. Verfügbar: ${this.channelList()}`;
    const normalized = argument.toLocaleLowerCase("en-US");
    if (normalized === "alle" || normalized === "*") return { scopeKey: "*", channelKey: "alle", label: "ALLE Kanäle" };
    // The chat accepts the key, the key without its platform prefix (that is how the sanitized
    // messages print it: "tiktok-clips" → "clips"), or the channel's display name. A person
    // types what they read; a printed "/fortsetzen clips" must work.
    const short = (key: string) => key.toLocaleLowerCase("en-US").replace(/^(instagram|tiktok|youtube)-/, "");
    const matches = this.deps.channels.filter((item) =>
      item.key.toLocaleLowerCase("en-US") === normalized || short(item.key) === normalized || item.name.toLocaleLowerCase("en-US") === normalized);
    if (matches.length > 1) return `⚠️ „${argument}“ ist mehrdeutig. Verfügbar: ${this.channelList()}`;
    const channel = matches[0];
    if (!channel) return `⚠️ Unbekannter Kanal „${argument}“. Verfügbar: ${this.channelList()}`;
    return { scopeKey: channel.accountId, channelKey: channel.key, label: `${channel.name} (${germanPlatformLabel(channel.platform)})` };
  }

  private channelList(): string {
    return `${this.deps.channels.map((channel) => `${channel.name} (${channel.key})`).join(", ")}, alle`;
  }

  private status(): string {
    const now = this.clock();
    const view = collectOperatorPlanView(this.deps.stores, this.deps.channels, this.today(), this.deps.timeZone, now);
    const identities = this.deps.stores.control.listBrowserIdentities();
    const lines: string[] = [];
    for (const channel of this.deps.channels) {
      const identity = identities.find((item) => item.identity.accountId === channel.accountId);
      const health = identity ? this.deps.stores.control.latestSessionHealth(identity.identity.identityId) : null;
      const state = health?.state ?? "MISSING";
      const paused = view.pauses.some((pause) => pause.scopeKey === "*" || pause.scopeKey === channel.accountId);
      const stopped = view.killSwitches.some((item) =>
        item.scopeType === "GLOBAL" || (item.scopeType === "ACCOUNT" && item.scopeKey === channel.accountId) || (item.scopeType === "PLATFORM" && item.scopeKey === channel.platform));
      lines.push(`${SESSION_BADGE[state] ?? "⚠️"} ${channel.name} (${germanPlatformLabel(channel.platform)}) · ${germanState(state)}${paused ? " · ⏸️ pausiert" : ""}${stopped ? " · 🛑 Kill-Switch" : ""}`);
    }
    const verified = view.entries.filter((entry) => entry.state === "VERIFIED").length;
    const blocked = view.entries.filter((entry) => entry.state === "BLOCKED").length;
    const uncertain = view.entries.filter((entry) => entry.state === "PUBLISH_UNCERTAIN").length;
    lines.push(`Heute: ${verified}/${view.entries.length} verifiziert · ${blocked} blockiert · ${uncertain} unsicher`);
    lines.push(`Offene Störungen: ${view.disturbances.length}`);
    lines.push(`Drive: ${view.pipeline.ready} bereit · ${view.pipeline.stabilizing} stabilisierend · ${view.pipeline.blocked} blockiert`);
    if (uncertain > 0) lines.push("🛑 Unsichere Posts sind eingefroren — Auflösung nur im Terminal.");
    return operatorMessageText(renderOperatorMessage("STATUS", {
      planLabel: germanDayLabel(this.today()),
      lines,
      ...(view.nextSlot ? { nextSlot: view.nextSlot } : {})
    }));
  }

  private plan(): string {
    return renderOperatorPlan(
      collectOperatorPlanView(this.deps.stores, this.deps.channels, this.today(), this.deps.timeZone, this.clock()),
      this.deps.channels
    );
  }

  private doctor(): string {
    let report: HeadlessDoctorReport;
    try { report = this.deps.doctor(); }
    catch (error) { return `🛑 Doctor fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`; }
    // German sentences for the operator, but the release SHA stays verbatim: it is the one value
    // a qualification argument actually turns on.
    const lines = [`Release ${report.releaseSha}`];
    for (const check of report.checks.filter((item) => item.status !== "PASS").slice(0, 10)) {
      lines.push(`${DOCTOR_BADGE[check.status] ?? "⚠️"} ${germanDoctorCheck(check.key)}: ${germanState(check.status)}`);
    }
    const channels = report.channels.map((channel) => {
      const named = this.deps.channels.find((item) => item.key === channel.channelKey);
      const ready = channel.routes.filter((route) => route.readyForAutonomousPublish).length;
      const blockers = [...new Set(channel.routes.flatMap((route) => route.blockers))].map(germanBlocker);
      const ok = ready === channel.routes.length && channel.routes.length > 0;
      return `${ok ? "✅" : "⚠️"} ${named?.name ?? channel.channelKey} · ${germanState(channel.latestSessionState)} · ${ready}/${channel.routes.length} Routen bereit${ok || blockers.length === 0 ? "" : ` — ${blockers.join(", ")}`}`;
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
