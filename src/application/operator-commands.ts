import type { StoredBrowserIdentity, SessionHealthCheck } from "../domain/browser-identity.js";
import type { KillSwitch, KillSwitchScopeType } from "../domain/operations.js";
import type { SchedulePauseStorePort } from "../domain/operator-ports.js";
import type { HeadlessDoctorReport } from "./headless-status.js";
import { businessDateForInstant } from "../domain/scheduling.js";
import { collectOperatorPlanView, renderOperatorPlan, type OperatorChannelRef, type OperatorPlanViewStores } from "./operator-plan-view.js";

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
    if (!argument) return `⚠️ Kanal fehlt: ${verb} <${this.deps.channels.map((channel) => channel.key).join("|")}|alle>`;
    const normalized = argument.toLocaleLowerCase("en-US");
    if (normalized === "alle" || normalized === "*") return { scopeKey: "*", channelKey: "alle", label: "ALLE Kanäle" };
    const channel = this.deps.channels.find((item) => item.key.toLocaleLowerCase("en-US") === normalized);
    if (!channel) return `⚠️ Unbekannter Kanal „${argument}“. Verfügbar: ${this.deps.channels.map((item) => item.key).join(", ")}, alle`;
    return { scopeKey: channel.accountId, channelKey: channel.key, label: `Kanal ${channel.key} (${channel.platform})` };
  }

  private status(): string {
    const view = collectOperatorPlanView(this.deps.stores, this.deps.channels, this.today(), this.deps.timeZone);
    const identities = this.deps.stores.control.listBrowserIdentities();
    const lines = [`📊 Status · ${this.today()}`];
    for (const channel of this.deps.channels) {
      const identity = identities.find((item) => item.identity.accountId === channel.accountId);
      const health = identity ? this.deps.stores.control.latestSessionHealth(identity.identity.identityId) : null;
      const state = health?.state ?? "MISSING";
      const paused = view.pauses.some((pause) => pause.scopeKey === "*" || pause.scopeKey === channel.accountId);
      const stopped = view.killSwitches.some((item) =>
        item.scopeType === "GLOBAL" || (item.scopeType === "ACCOUNT" && item.scopeKey === channel.accountId) || (item.scopeType === "PLATFORM" && item.scopeKey === channel.platform));
      lines.push(`${SESSION_BADGE[state] ?? "⚠️"} ${channel.key} (${channel.platform}) · Session ${state}${paused ? " · ⏸️ pausiert" : ""}${stopped ? " · 🛑 Kill-Switch" : ""}`);
    }
    const verified = view.entries.filter((entry) => entry.state === "VERIFIED").length;
    const blocked = view.entries.filter((entry) => entry.state === "BLOCKED").length;
    const uncertain = view.entries.filter((entry) => entry.state === "PUBLISH_UNCERTAIN").length;
    lines.push(`Heute: ${verified}/${view.entries.length} verifiziert · ${blocked} blockiert · ${uncertain} unsicher`);
    lines.push(`Offene Störungen: ${view.disturbances.length}`);
    lines.push(`Drive: ${view.pipeline.ready} READY · ${view.pipeline.stabilizing} stabilisierend · ${view.pipeline.blocked} blockiert`);
    if (uncertain > 0) lines.push("🛑 UNSICHER-Posts sind eingefroren — Auflösung nur über verify im Terminal.");
    return lines.join("\n").slice(0, 4000);
  }

  private plan(): string {
    return renderOperatorPlan(collectOperatorPlanView(this.deps.stores, this.deps.channels, this.today(), this.deps.timeZone));
  }

  private doctor(): string {
    let report: HeadlessDoctorReport;
    try { report = this.deps.doctor(); }
    catch (error) { return `🛑 Doctor fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`; }
    const lines = [`${DOCTOR_BADGE[report.overall] ?? "⚠️"} Doctor · ${report.workspaceId} · Gesamt: ${report.overall}`];
    for (const check of report.checks.filter((item) => item.status !== "PASS").slice(0, 10)) {
      lines.push(`${DOCTOR_BADGE[check.status]} ${check.key}: ${check.detail}`);
    }
    for (const channel of report.channels) {
      const ready = channel.routes.filter((route) => route.readyForAutonomousPublish).length;
      lines.push(`${ready === channel.routes.length && channel.routes.length > 0 ? "✅" : "⚠️"} ${channel.channelKey}: Session ${channel.latestSessionState} · ${ready}/${channel.routes.length} Routen bereit`);
    }
    return lines.join("\n").slice(0, 4000);
  }

  private pause(argument: string | undefined): string {
    const scope = this.resolveScope(argument, "/pause");
    if (typeof scope === "string") return scope;
    this.deps.pauses.setSchedulePause({ scopeKey: scope.scopeKey, channelKey: scope.channelKey, reason: "operator_pause", pausedAt: this.clock(), pausedBy: this.operatorId });
    return `⏸️ ${scope.label} pausiert. Fällige Posts bleiben SCHEDULED. Fortsetzen: /fortsetzen ${scope.channelKey}`;
  }

  private resume(argument: string | undefined): string {
    const scope = this.resolveScope(argument, "/fortsetzen");
    if (typeof scope === "string") return scope;
    const cleared = this.deps.pauses.clearSchedulePause(scope.scopeKey);
    if (!cleared) return `ℹ️ ${scope.label} war nicht pausiert.`;
    const activeSwitches = this.deps.stores.control.listKillSwitches(true);
    const stillStopped = activeSwitches.length > 0 ? " ⚠️ Achtung: Kill-Switch weiterhin aktiv — Deaktivierung nur im Terminal." : "";
    return `▶️ ${scope.label} fortgesetzt.${stillStopped}`;
  }

  private stop(argument: string | undefined): string {
    const scope = this.resolveScope(argument, "/stopp");
    if (typeof scope === "string") return scope;
    const scopeType: KillSwitchScopeType = scope.scopeKey === "*" ? "GLOBAL" : "ACCOUNT";
    this.deps.killSwitches.set(scopeType, scope.scopeKey, true, `telegram_stopp:${scope.channelKey}`, this.clock(), this.operatorId);
    return `🛑 Kill-Switch AKTIVIERT für ${scope.label}. Es wird nichts mehr veröffentlicht. Deaktivieren ist über den Chat nicht möglich — nur im Terminal.`;
  }
}
