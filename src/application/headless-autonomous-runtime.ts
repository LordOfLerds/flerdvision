import { resolve } from "node:path";
import { findLatestRecording } from "../adapters/browser/prepare-artifacts.js";
import { setTimeout as sleep } from "node:timers/promises";
import { KillSwitchGate } from "./operations.js";
import { RuntimeSupervisor, type RuntimeCycleReport } from "./runtime-supervisor.js";
import { loadWorkspaceSpecFile } from "./headless-bootstrap.js";
import { accountIdForChannel } from "./workspace-spec-compiler.js";
import type { PublicationIntent } from "../domain/model.js";
import type { PublishContext } from "../domain/ports.js";
import { AuthorizedRuntimeDueExecutionAdapter } from "../adapters/runtime/authorized-due-execution.js";
import { telegramAdapterFromEnv } from "../adapters/notify/telegram.js";
import { TelegramOperatorService } from "./telegram-operator-runtime.js";
import { JsonDistributionConfigurationStore } from "../adapters/distribution/json-config-store.js";
import { SqliteOperatorStateStore } from "../adapters/storage/sqlite-operator-state.js";
import { withDriveFolders } from "./operator-plan-view.js";
import { workspaceRuntimeLayout } from "./workspaces.js";
import { inspectHeadlessWorkspace } from "./headless-status.js";
import { resolveQualificationReplays } from "./qualification-policy.js";
import { currentSurfaceFingerprintOrUndefined, surfaceFingerprintMatches } from "./surface-fingerprint.js";
import { WorkspaceDistributionRuntime } from "../adapters/runtime/workspace-distribution-runtime.js";
import { WorkspaceSurfacePublisher } from "../adapters/runtime/workspace-surface-publisher.js";
import { filenameParts } from "../adapters/publish/workspace-payload-resolver.js";
import type { OperatorNextSlot } from "./operator-message.js";

function businessDate(now: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(now));
  const value = (type: string) => parts.find((part) => part.type === type)?.value;
  const year = value("year"), month = value("month"), day = value("day");
  if (!year || !month || !day) throw new Error(`Could not derive business date in ${timeZone}`);
  return `${year}-${month}-${day}`;
}
function localSlot(instant: string, timeZone: string): string {
  try { return new Intl.DateTimeFormat("de-AT", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(instant)); }
  catch { return instant.slice(11, 16); }
}
/**
 * Autonomous publishing requires that the surface code the route was qualified against is the
 * surface code that is about to drive the browser. It deliberately does NOT require the private
 * E2E post any more: the operator decision of 2026-09-03 is that the first scheduled slot is the
 * first post, and the private E2E stays available for whoever wants to run it.
 */
function assertExactSurfaceQualification(base: WorkspaceDistributionRuntime, allowedAccountIds: ReadonlySet<string>, env: Record<string, string | undefined>): void {
  const config = base.config.load();
  const currentFingerprint = currentSurfaceFingerprintOrUndefined();
  const requiredReplays = resolveQualificationReplays(env);
  for (const accountId of allowedAccountIds) {
    const identities = base.control.listBrowserIdentities().map((record) => record.identity).filter((identity) => identity.accountId === accountId && identity.enabled);
    if (identities.length !== 1) throw new Error(`Autonomous account ${accountId} requires exactly one enabled browser identity; found ${identities.length}`);
    const health = base.control.latestSessionHealth(identities[0]!.identityId);
    if (health?.state !== "HEALTHY") throw new Error(`Autonomous account ${accountId} session is not HEALTHY`);
    const routes = config.config.routes.filter((route) => route.enabled && route.accountId === accountId);
    if (routes.length === 0) throw new Error(`Autonomous account ${accountId} has no enabled routes`);
    // One unqualified route must not take the whole daemon down: a Trial-Reel route waiting for
    // Instagram's switch, or a YouTube route not yet qualified, is skipped with one clear line
    // while the channel's qualified routes keep posting. Only an account with no qualified
    // route at all is a startup error.
    const unqualified: string[] = [];
    for (const route of routes) {
      const readiness = base.state.latestRouteTestReadiness(route.routeId)?.readiness;
      const surface = base.surfaces.latestContract(accountId, route.postingProfileId)?.contract;
      const reasons: string[] = [];
      if (!readiness) reasons.push("route_readiness_missing");
      else {
        // The release SHA stays recorded evidence; only the surface fingerprint decides whether
        // the qualification still describes the code that is about to drive the browser.
        if (!surfaceFingerprintMatches(readiness.surfaceFingerprint, currentFingerprint)) reasons.push("surface_fingerprint_stale");
        if (!readiness.sourcePassed) reasons.push("source_not_proven");
        if (!readiness.sessionPassed) reasons.push("session_not_proven");
        if (!readiness.identityPassed) reasons.push("identity_not_proven");
        if (readiness.prepareOnlyPasses < requiredReplays) reasons.push("prepare_only_replays_missing");
        if (!readiness.verificationPassed) reasons.push("verification_surface_not_proven");
      }
      if (!surface || surface.status !== "CALIBRATED") reasons.push("surface_not_calibrated");
      else if (readiness?.surfaceContractId !== surface.contractId) reasons.push("surface_evidence_stale");
      if (reasons.length > 0) {
        unqualified.push(route.routeId);
        console.error(`Route ${route.displayName} wird übersprungen — nicht freigegeben: ${reasons.join(", ")}`);
      }
    }
    if (unqualified.length === routes.length) throw new Error(`Autonomous account ${accountId} has no qualified route: ${unqualified.join(", ")}`);
  }
}

/**
 * Best effort: a workspace whose configuration cannot be read still runs, it just cannot offer
 * the Drive folder links. Never a reason to refuse to start.
 */
function distributionConfigOrUndefined(runtimeRoot: string, workspaceId: string) {
  try {
    const layout = workspaceRuntimeLayout(resolve(runtimeRoot), workspaceId);
    return new JsonDistributionConfigurationStore(resolve(layout.configDir, "distribution.json")).load();
  } catch { return undefined; }
}

export interface HeadlessAutonomousRuntimeOptions {
  specPath: string;
  releaseSha: string;
  mode: "canary" | "production";
  channelKeys: readonly string[];
  allowFinalPublish: boolean;
  env?: Record<string, string | undefined>;
  ownerId?: string;
  headless?: boolean;
  maxPerCycle?: number;
}

interface AutonomousComposition {
  base: WorkspaceDistributionRuntime;
  publisher: WorkspaceSurfacePublisher;
  supervisor: RuntimeSupervisor;
  timeZone: string;
  allowedAccountIds: ReadonlySet<string>;
  operator?: TelegramOperatorService;
  operatorState?: SqliteOperatorStateStore;
}

function composeAutonomousRuntime(options: HeadlessAutonomousRuntimeOptions): AutonomousComposition {
  if (!options.releaseSha.trim()) throw new Error("Autonomous runtime requires an exact release SHA");
  if (options.channelKeys.length === 0) throw new Error("Autonomous runtime requires an explicit non-empty channel allowlist");
  if (!options.allowFinalPublish) throw new Error("Autonomous runtime remains disabled until the independent final-publish hard gate is explicitly true");
  const maxPerCycle = options.maxPerCycle ?? 4;
  if (!Number.isInteger(maxPerCycle) || maxPerCycle < 1 || maxPerCycle > 100) throw new Error("Autonomous runtime maxPerCycle must be an integer from 1 to 100");
  const spec = loadWorkspaceSpecFile(options.specPath);
  const selected = spec.channels.filter((channel) => options.channelKeys.includes(channel.key));
  const unknown = options.channelKeys.filter((key) => !spec.channels.some((channel) => channel.key === key));
  if (unknown.length > 0) throw new Error(`Unknown channel allowlist entries: ${unknown.join(", ")}`);
  const allowedAccountIds: ReadonlySet<string> = new Set(selected.map(accountIdForChannel));
  const env = options.env ?? process.env;
  const ownerId = options.ownerId ?? `${spec.workspace.id}:headless-autonomous`;
  const operatorChannels = withDriveFolders(
    selected.map((channel) => ({ key: channel.key, name: channel.name, platform: channel.platform, accountId: accountIdForChannel(channel) })),
    distributionConfigOrUndefined(spec.workspace.runtimeRoot, spec.workspace.id)
  );
  const base = new WorkspaceDistributionRuntime({
    runtimeRoot: spec.workspace.runtimeRoot,
    workspaceId: spec.workspace.id,
    env,
    timeZone: spec.workspace.timezone,
    releaseSha: options.releaseSha,
    channels: operatorChannels
  });
  let publisher: WorkspaceSurfacePublisher | undefined;
  try {
    assertExactSurfaceQualification(base, allowedAccountIds, env);
    publisher = new WorkspaceSurfacePublisher({
      runtimeRoot: spec.workspace.runtimeRoot,
      workspaceId: spec.workspace.id,
      releaseSha: options.releaseSha,
      env,
      ownerId,
      headless: options.headless ?? true
    });
    // The operator layer (Telegram) is optional and read-mostly: when configured it also owns
    // the composite publish gate so /pause is respected by the due worker without burning
    // intents. Without credentials the plain kill-switch gate stands alone as before.
    const operatorState = new SqliteOperatorStateStore(base.layout.databasePath);
    const operator = TelegramOperatorService.fromEnv({
      env,
      channels: operatorChannels,
      control: base.control,
      state: base.state,
      operatorState,
      doctor: () => inspectHeadlessWorkspace({ specPath: options.specPath, releaseSha: options.releaseSha, env }),
      timeZone: spec.workspace.timezone
    });
    const operationalGate = operator ? operator.publishGate() : new KillSwitchGate(base.control);
    const contextProvider = (intent: PublicationIntent): PublishContext => {
      if (!allowedAccountIds.has(intent.accountId)) throw new Error(`Intent ${intent.intentId} is outside the autonomous channel allowlist`);
      return { mode: options.mode, allowFinalPublish: true, allowedAccountIds, releaseSha: options.releaseSha };
    };
    const channelNames = Object.fromEntries(selected.map((channel) => [accountIdForChannel(channel), channel.name]));
    const activePublisher = publisher;
    // Operator messages name the video the way Luca named it in Drive and quote the copy the
    // publisher actually posted; both lookups are best-effort and never block a cycle.
    const describeContent = async (intent: PublicationIntent) => {
      const filename = base.state.listAssets().find((record) => record.asset.contentId === intent.contentId)?.asset.filename;
      const parts = filename ? filenameParts(filename) : undefined;
      let payload: { caption?: string; title?: string } | undefined;
      try { payload = await activePublisher.payloads.resolve(intent); } catch { payload = undefined; }
      return {
        ...(parts?.text ? { videoLabel: parts.text } : {}),
        ...(parts?.hashtags ? { hashtags: parts.hashtags } : {}),
        ...(payload?.caption ? { caption: payload.caption } : {}),
        ...(payload?.title ? { title: payload.title } : {})
      };
    };
    const nextSlot = (now: string): OperatorNextSlot | undefined => {
      const upcoming = base.control.listIntents(["PLANNED", "READY", "SCHEDULED"])
        .filter((record) => record.intent.scheduledFor > now)
        .sort((a, b) => a.intent.scheduledFor.localeCompare(b.intent.scheduledFor));
      const first = upcoming[0];
      if (!first) return undefined;
      const names = upcoming
        .filter((record) => record.intent.scheduledFor === first.intent.scheduledFor)
        .map((record) => channelNames[record.intent.accountId])
        .filter((name): name is string => Boolean(name));
      return { timeLocal: localSlot(first.intent.scheduledFor, spec.workspace.timezone), channelNames: [...new Set(names)] };
    };
    const due = new AuthorizedRuntimeDueExecutionAdapter(
      base.control,
      publisher,
      operationalGate,
      contextProvider,
      { releaseSha: options.releaseSha, ownerId, maxPerCycle, notificationAdapters: [...(telegramAdapterFromEnv(env) ? [telegramAdapterFromEnv(env)!] : [])], timeZone: spec.workspace.timezone, channelNames, describeContent, nextSlot, findRecording: (intent: PublicationIntent) => findLatestRecording(resolve(base.layout.evidenceDir, "publisher"), intent.intentId) }
    );
    const supervisor = new RuntimeSupervisor({
      lease: base.lease,
      source: base.source,
      planner: base.planner,
      intents: base.intents,
      due,
      reconciliation: base.reconciliation,
      disposition: base.disposition,
      operations: base.operations,
      reports: base.reports
    }, ownerId);
    return { base, publisher, supervisor, timeZone: spec.workspace.timezone, allowedAccountIds, ...(operator ? { operator } : {}), operatorState };
  } catch (error) {
    if (publisher) void publisher.close().catch(() => {});
    base.close();
    throw error;
  }
}

/**
 * Real autonomous composition. It reuses the canonical source/planner/intent/disposition/ops ports
 * but replaces the deliberately frozen due phase with the hardened authorized worker.
 * Construction never authorizes anything: caller must provide exact release, explicit channel
 * allowlist and the independent final-publish hard gate. Every allowed route must also be
 * qualified against the exact surface fingerprint that is about to drive the browser.
 */
export class HeadlessAutonomousRuntime {
  private readonly base: WorkspaceDistributionRuntime;
  private readonly publisher: WorkspaceSurfacePublisher;
  private readonly supervisor: RuntimeSupervisor;
  private readonly timeZone: string;
  readonly allowedAccountIds: ReadonlySet<string>;
  private readonly releaseSha: string;
  private readonly env: Record<string, string | undefined>;
  private readonly operator?: TelegramOperatorService;
  private readonly operatorState?: SqliteOperatorStateStore;

  constructor(options: HeadlessAutonomousRuntimeOptions) {
    const composition = composeAutonomousRuntime(options);
    this.base = composition.base;
    this.publisher = composition.publisher;
    this.supervisor = composition.supervisor;
    this.timeZone = composition.timeZone;
    this.allowedAccountIds = composition.allowedAccountIds;
    this.releaseSha = options.releaseSha;
    this.env = options.env ?? process.env;
    if (composition.operator) this.operator = composition.operator;
    if (composition.operatorState) this.operatorState = composition.operatorState;
  }

  async runOnce(now = new Date().toISOString()): Promise<RuntimeCycleReport> {
    assertExactSurfaceQualification(this.base, this.allowedAccountIds, this.env);
    const report = await this.supervisor.runCycle(new Date(now).toISOString(), businessDate(now, this.timeZone));
    // Checklist edits, reports and session alarms ride each cycle; the service contains its own
    // Telegram failures and must never break the publishing cycle it narrates.
    await this.operator?.tick().catch(() => {});
    return report;
  }

  async runDaemon(input: { intervalSeconds?: number; signal?: { aborted: boolean }; onCycle?: (report: RuntimeCycleReport) => void }): Promise<void> {
    const interval = input.intervalSeconds ?? 60;
    if (!Number.isInteger(interval) || interval < 15 || interval > 3600) throw new Error("Daemon interval must be an integer from 15 to 3600 seconds");
    const loopSignal = input.signal ?? { aborted: false };
    if (this.operator) void this.operator.runCommandLoop(loopSignal).catch(() => {});
    while (!input.signal?.aborted) {
      const report = await this.runOnce();
      input.onCycle?.(report);
      if (input.signal?.aborted) break;
      await sleep(interval * 1000);
    }
  }

  async close(): Promise<void> {
    await this.publisher.close();
    this.operatorState?.close();
    this.base.close();
  }
}
