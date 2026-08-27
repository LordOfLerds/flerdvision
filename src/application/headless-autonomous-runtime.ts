import { setTimeout as sleep } from "node:timers/promises";
import { KillSwitchGate } from "./operations.js";
import { RuntimeSupervisor } from "./runtime-supervisor.js";
import { loadWorkspaceSpecFile } from "./headless-bootstrap.js";
import { accountIdForChannel } from "./workspace-spec-compiler.js";
import type { PublishContext } from "../domain/ports.js";
import type { RuntimeCycleReport } from "../domain/runtime-supervisor-ports.js";
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
 * but replaces the deliberately frozen due phase with the already hardened authorized worker.
 * Construction never authorizes anything: caller must provide exact release, explicit channel
 * allowlist and the independent final-publish hard gate.
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
    this.publisher = new WorkspaceSurfacePublisher({
      runtimeRoot: spec.workspace.runtimeRoot,
      workspaceId: spec.workspace.id,
      releaseSha: options.releaseSha,
      env,
      ownerId: options.ownerId ?? `${spec.workspace.id}:headless-autonomous`,
      headless: options.headless ?? true
    });
    const operationalGate = new KillSwitchGate(this.base.control);
    const contextProvider = (): PublishContext => ({
      mode: options.mode,
      allowFinalPublish: true,
      allowedAccountIds: this.allowedAccountIds,
      releaseSha: options.releaseSha
    });
    const due = new AuthorizedRuntimeDueExecutionAdapter(
      this.base.control,
      this.publisher,
      operationalGate,
      contextProvider,
      {
        releaseSha: options.releaseSha,
        ownerId: options.ownerId ?? `${spec.workspace.id}:headless-autonomous`,
        maxPerCycle: options.maxPerCycle ?? 4
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

  async runOnce(now = new Date().toISOString()): Promise<RuntimeCycleReport> {
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
