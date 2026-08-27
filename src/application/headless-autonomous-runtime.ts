import { setTimeout as sleep } from "node:timers/promises";
import { KillSwitchGate } from "./operations.js";
import { RuntimeSupervisor, type RuntimeCycleReport } from "./runtime-supervisor.js";
import { loadWorkspaceSpecFile } from "./headless-bootstrap.js";
import { accountIdForChannel } from "./workspace-spec-compiler.js";
import type { PublicationIntent } from "../domain/model.js";
import type { PublishContext } from "../domain/ports.js";
import type { RouteTestEvidenceRecord } from "../domain/route-test-ports.js";
import { SqliteRouteTestEvidenceStore } from "../adapters/distribution/sqlite-route-test-evidence.js";
import { AuthorizedRuntimeDueExecutionAdapter } from "../adapters/runtime/authorized-due-execution.js";
import { WorkspaceDistributionRuntime } from "../adapters/runtime/workspace-distribution-runtime.js";
import { WorkspaceSurfacePublisher } from "../adapters/runtime/workspace-surface-publisher.js";

function businessDate(now: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(now));
  const value = (type: string) => parts.find((part) => part.type === type)?.value;
  const year = value("year"), month = value("month"), day = value("day");
  if (!year || !month || !day) throw new Error(`Could not derive business date in ${timeZone}`);
  return `${year}-${month}-${day}`;
}
function latest(records: readonly RouteTestEvidenceRecord[], key: RouteTestEvidenceRecord["testKey"]): RouteTestEvidenceRecord | undefined {
  return records.filter((record) => record.testKey === key && record.status === "PASS").sort((a, b) => a.checkedAt.localeCompare(b.checkedAt)).at(-1);
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

/**
 * Real autonomous composition. It reuses the canonical source/planner/intent/disposition/ops ports
 * but replaces the deliberately frozen due phase with the hardened authorized worker.
 * Construction never authorizes anything: caller must provide exact release, explicit channel
 * allowlist and the independent final-publish hard gate. Every allowed route must also have an
 * exact-release private E2E post and cleanup receipt for its current surface contract.
 */
export class HeadlessAutonomousRuntime {
  private readonly base: WorkspaceDistributionRuntime;
  private readonly publisher: WorkspaceSurfacePublisher;
  private readonly supervisor: RuntimeSupervisor;
  private readonly timeZone: string;
  readonly allowedAccountIds: ReadonlySet<string>;

  constructor(private readonly options: HeadlessAutonomousRuntimeOptions) {
    if (!options.releaseSha.trim()) throw new Error("Autonomous runtime requires an exact release SHA");
    if (options.channelKeys.length === 0) throw new Error("Autonomous runtime requires an explicit non-empty channel allowlist");
    if (!options.allowFinalPublish) throw new Error("Autonomous runtime remains disabled until the independent final-publish hard gate is explicitly true");
    const maxPerCycle = options.maxPerCycle ?? 4;
    if (!Number.isInteger(maxPerCycle) || maxPerCycle < 1 || maxPerCycle > 100) throw new Error("Autonomous runtime maxPerCycle must be an integer from 1 to 100");
    const spec = loadWorkspaceSpecFile(options.specPath);
    const selected = spec.channels.filter((channel) => options.channelKeys.includes(channel.key));
    const unknown = options.channelKeys.filter((key) => !spec.channels.some((channel) => channel.key === key));
    if (unknown.length > 0) throw new Error(`Unknown channel allowlist entries: ${unknown.join(", ")}`);
    this.allowedAccountIds = new Set(selected.map(accountIdForChannel));
    this.timeZone = spec.workspace.timezone;
    const env = options.env ?? process.env;
    this.base = new WorkspaceDistributionRuntime({
      runtimeRoot: spec.workspace.runtimeRoot,
      workspaceId: spec.workspace.id,
      env,
      timeZone: spec.workspace.timezone,
      releaseSha: options.releaseSha
    });
    try {
      this.assertExactReleaseQualification();
      this.publisher = new WorkspaceSurfacePublisher({
        runtimeRoot: spec.workspace.runtimeRoot,
        workspaceId: spec.workspace.id,
        releaseSha: options.releaseSha,
        env,
        ownerId: options.ownerId ?? `${spec.workspace.id}:headless-autonomous`,
        headless: options.headless ?? true
      });
    } catch (error) {
      this.base.close();
      throw error;
    }
    const operationalGate = new KillSwitchGate(this.base.control);
    const contextProvider = (intent: PublicationIntent): PublishContext => {
      if (!this.allowedAccountIds.has(intent.accountId)) throw new Error(`Intent ${intent.intentId} is outside the autonomous channel allowlist`);
      return { mode: options.mode, allowFinalPublish: true, allowedAccountIds: this.allowedAccountIds, releaseSha: options.releaseSha };
    };
    const due = new AuthorizedRuntimeDueExecutionAdapter(
      this.base.control,
      this.publisher,
      operationalGate,
      contextProvider,
      {
        releaseSha: options.releaseSha,
        ownerId: options.ownerId ?? `${spec.workspace.id}:headless-autonomous`,
        maxPerCycle
      }
    );
    this.supervisor = new RuntimeSupervisor({
      lease: this.base.lease,
      source: this.base.source,
      planner: this.base.planner,
      intents: this.base.intents,
      due,
      reconciliation: this.base.reconciliation,
      disposition: this.base.disposition,
      operations: this.base.operations,
      reports: this.base.reports
    }, options.ownerId ?? `${spec.workspace.id}:headless-autonomous`);
  }

  private assertExactReleaseQualification(): void {
    const config = this.base.config.load();
    const evidence = new SqliteRouteTestEvidenceStore(this.base.layout.databasePath);
    try {
      for (const accountId of this.allowedAccountIds) {
        const identities = this.base.control.listBrowserIdentities().map((record) => record.identity).filter((identity) => identity.accountId === accountId && identity.enabled);
        if (identities.length !== 1) throw new Error(`Autonomous account ${accountId} requires exactly one enabled browser identity; found ${identities.length}`);
        const health = this.base.control.latestSessionHealth(identities[0]!.identityId);
        if (health?.state !== "HEALTHY") throw new Error(`Autonomous account ${accountId} session is not HEALTHY`);
        const routes = config.config.routes.filter((route) => route.enabled && route.accountId === accountId);
        if (routes.length === 0) throw new Error(`Autonomous account ${accountId} has no enabled routes`);
        for (const route of routes) {
          const readiness = this.base.state.latestRouteTestReadiness(route.routeId)?.readiness;
          const surface = this.base.surfaces.latestContract(accountId, route.postingProfileId)?.contract;
          const reasons: string[] = [];
          if (!readiness) reasons.push("route_readiness_missing");
          else {
            if (readiness.releaseSha !== this.options.releaseSha) reasons.push("route_release_stale");
            if (!readiness.sourcePassed) reasons.push("source_not_proven");
            if (!readiness.sessionPassed) reasons.push("session_not_proven");
            if (!readiness.identityPassed) reasons.push("identity_not_proven");
            if (readiness.prepareOnlyPasses < 3) reasons.push("prepare_only_lt_3");
            if (!readiness.verificationPassed) reasons.push("verification_surface_not_proven");
          }
          if (!surface || surface.status !== "CALIBRATED") reasons.push("surface_not_calibrated");
          else if (readiness?.surfaceContractId !== surface.contractId) reasons.push("surface_evidence_stale");
          const records = evidence.list(route.routeId).filter((record) => record.releaseSha === this.options.releaseSha && (!surface || record.surfaceContractId === surface.contractId));
          const secretLive = latest(records, "SECRET_LIVE");
          const cleanup = latest(records, "CLEANUP");
          if (!secretLive) reasons.push("private_e2e_missing");
          if (!cleanup || (secretLive && cleanup.checkedAt <= secretLive.checkedAt)) reasons.push("private_e2e_cleanup_missing_or_stale");
          if (reasons.length > 0) throw new Error(`Route ${route.routeId} is not autonomous-release-qualified: ${reasons.join(", ")}`);
        }
      }
    } finally { evidence.close(); }
  }

  async runOnce(now = new Date().toISOString()): Promise<RuntimeCycleReport> {
    this.assertExactReleaseQualification();
    return await this.supervisor.runCycle(new Date(now).toISOString(), businessDate(now, this.timeZone));
  }

  async runDaemon(input: { intervalSeconds?: number; signal?: { aborted: boolean }; onCycle?: (report: RuntimeCycleReport) => void }): Promise<void> {
    const interval = input.intervalSeconds ?? 60;
    if (!Number.isInteger(interval) || interval < 15 || interval > 3600) throw new Error("Daemon interval must be an integer from 15 to 3600 seconds");
    while (!input.signal?.aborted) {
      const report = await this.runOnce();
      input.onCycle?.(report);
      if (input.signal?.aborted) break;
      await sleep(interval * 1000);
    }
  }

  async close(): Promise<void> {
    await this.publisher.close();
    this.base.close();
  }
}
