import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { aiProviderPreflight } from "../../application/ai-provider.js";
import { AutoDiagnosisCoordinator, type IncidentDiagnosisRunnerPort } from "../../application/auto-diagnosis.js";
import { RepairPolicy, validateAiDiagnosisDraft } from "../../application/ai-repair.js";
import { DiagnosisNotificationProjector } from "../../application/diagnosis-notifications.js";
import { NotificationDispatcher } from "../../application/notifications.js";
import type { Actor } from "../../domain/control-plane.js";
import type { AiProviderConfig, AiProviderMode } from "../../domain/ai-provider.js";
import type { IncidentStorePort } from "../../domain/operations-ports.js";
import type { RuntimeOperationsPort, RuntimeOperationsReport } from "../../domain/runtime-supervisor-ports.js";
import type { AiDiagnosisPort, IncidentEvidenceBundleBuilderPort, RepairStorePort } from "../../domain/repair-ports.js";
import type { AiDiagnosis, RepairPolicyVerdict } from "../../domain/repair.js";
import { telegramAdapterFromEnv } from "../notify/telegram.js";
import { CommandAiDiagnosisAdapter } from "../repair/command-ai.js";
import { IncidentEvidenceBundleBuilder, SafeLocalArtifactTextReader } from "../repair/redaction.js";
import type { SqliteControlPlaneStore } from "../storage/sqlite.js";

const PROVIDER_MODES = new Set<AiProviderMode>(["disabled", "claude_subscription_cli", "codex_chatgpt_cli", "anthropic_api", "openai_api"]);
const AUTO_DIAGNOSIS_TIMEOUT_CEILING_MS = 15_000;
const AUTO_DIAGNOSIS_TIMEOUT_FLOOR_MS = 500;
const AI_ENV_KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"] as const;

function stableId(prefix: string, value: string): string {
  return `${prefix}:${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

function iso(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid timestamp: ${value}`);
  return date.toISOString();
}

export function parseAiProviderConfig(value: unknown): AiProviderConfig {
  if (!value || typeof value !== "object") throw new Error("AI provider config must be an object");
  const item = value as Record<string, unknown>;
  if (typeof item.mode !== "string" || !PROVIDER_MODES.has(item.mode as AiProviderMode)) throw new Error("Invalid AI provider mode");
  if (typeof item.enabled !== "boolean") throw new Error("AI provider enabled must be boolean");
  const config: AiProviderConfig = { mode: item.mode as AiProviderMode, enabled: item.enabled };
  if (typeof item.wrapperCommand === "string") Object.assign(config, { wrapperCommand: item.wrapperCommand });
  if (Array.isArray(item.wrapperArgs) && item.wrapperArgs.every((entry) => typeof entry === "string")) Object.assign(config, { wrapperArgs: item.wrapperArgs as string[] });
  if (typeof item.timeoutMs === "number") Object.assign(config, { timeoutMs: item.timeoutMs });
  return config;
}

/** Diagnosis-only runtime service. It has no repair-proposal or workspace mutation capability. */
export class PersistingIncidentDiagnosisRunner implements IncidentDiagnosisRunnerPort {
  constructor(
    private readonly incidents: IncidentStorePort,
    private readonly repairStore: RepairStorePort,
    private readonly bundleBuilder: IncidentEvidenceBundleBuilderPort,
    private readonly diagnosisPort: AiDiagnosisPort,
    private readonly policy = new RepairPolicy()
  ) {}

  async diagnoseIncident(
    incidentId: string,
    params: { now: string; releaseSha: string; adapterVersion: string },
    actor: Actor = { type: "system", id: "auto-diagnosis" }
  ): Promise<{ verdict: RepairPolicyVerdict }> {
    const incident = this.incidents.getIncident(incidentId);
    if (!incident) throw new Error(`Unknown incident: ${incidentId}`);
    const bundle = this.repairStore.recordEvidenceBundle(
      this.bundleBuilder.build(incident, { capturedAt: params.now, releaseSha: params.releaseSha, adapterVersion: params.adapterVersion }),
      actor
    );
    const raw = validateAiDiagnosisDraft(await this.diagnosisPort.diagnose(bundle));
    const diagnosis: AiDiagnosis = {
      ...raw,
      diagnosisId: stableId("diagnosis", `${bundle.bundleId}|${JSON.stringify(raw)}`),
      bundleId: bundle.bundleId,
      incidentId,
      createdAt: iso(params.now)
    };
    this.repairStore.recordAiDiagnosis(diagnosis, actor);
    return { verdict: this.policy.evaluate(incident.kind, diagnosis) };
  }
}

export interface WorkspaceAutoDiagnosisOptions {
  store: SqliteControlPlaneStore;
  configDir: string;
  evidenceDir: string;
  releaseSha: string;
  adapterVersion: string;
  env?: Record<string, string | undefined>;
  onUnavailable?: (message: string) => void;
}

export interface AutoDiagnosisRunner {
  run(now: string): Promise<unknown>;
}

function commandEnvironment(env: Record<string, string | undefined>): Record<string, string> {
  const output: Record<string, string> = {};
  for (const key of AI_ENV_KEYS) {
    const value = env[key];
    if (value?.trim()) output[key] = value;
  }
  return output;
}

class WorkspaceAutoDiagnosisLifecycle implements AutoDiagnosisRunner {
  constructor(
    private readonly coordinator: AutoDiagnosisCoordinator,
    private readonly projector?: DiagnosisNotificationProjector,
    private readonly dispatcher?: NotificationDispatcher
  ) {}

  async run(now: string): Promise<unknown> {
    const report = await this.coordinator.run(now);
    if (this.projector && this.dispatcher && report.diagnosedIncidentIds.length > 0) {
      try {
        const projected = this.projector.enqueueDiagnosed(report.diagnosedIncidentIds, now);
        if (projected.enqueued > 0) await this.dispatcher.dispatchPending(now, { type: "system", id: "diagnosis-notification" });
      } catch {
        // Chat lifecycle updates must not alter the diagnosis result or publishing cycle.
      }
    }
    return report;
  }
}

/**
 * Optional by configuration, never by hidden fallback. A missing/disabled provider leaves the
 * publisher untouched. An explicitly enabled but unavailable provider is reported and skipped;
 * diagnosis must never become a publishing availability dependency.
 */
export function createWorkspaceAutoDiagnosis(options: WorkspaceAutoDiagnosisOptions): AutoDiagnosisRunner | undefined {
  const configPath = resolve(options.configDir, "ai-provider.json");
  if (!existsSync(configPath)) return undefined;
  let config: AiProviderConfig;
  try { config = parseAiProviderConfig(JSON.parse(readFileSync(configPath, "utf8")) as unknown); }
  catch (error) {
    options.onUnavailable?.(`Auto-Diagnose deaktiviert: ungültige AI-Konfiguration (${error instanceof Error ? error.message : String(error)})`);
    return undefined;
  }
  if (!config.enabled || config.mode === "disabled") return undefined;
  const env = options.env ?? process.env;
  const preflight = aiProviderPreflight(config, env);
  if (!preflight.ready || !config.wrapperCommand?.trim()) {
    const failed = preflight.checks.filter((check) => !check.passed).map((check) => check.detail).join("; ");
    options.onUnavailable?.(`Auto-Diagnose deaktiviert: ${failed || "AI-Provider nicht bereit"}`);
    return undefined;
  }

  const requestedTimeout = config.timeoutMs ?? AUTO_DIAGNOSIS_TIMEOUT_CEILING_MS;
  const timeoutMs = Math.min(AUTO_DIAGNOSIS_TIMEOUT_CEILING_MS, Math.max(AUTO_DIAGNOSIS_TIMEOUT_FLOOR_MS, requestedTimeout));
  const diagnosisPort = new CommandAiDiagnosisAdapter({
    command: config.wrapperCommand,
    ...(config.wrapperArgs ? { args: config.wrapperArgs } : {}),
    timeoutMs,
    env: commandEnvironment(env)
  });
  const builder = new IncidentEvidenceBundleBuilder(options.store, new SafeLocalArtifactTextReader(options.evidenceDir));
  const runner = new PersistingIncidentDiagnosisRunner(options.store, options.store, builder, diagnosisPort);
  const coordinator = new AutoDiagnosisCoordinator(options.store, options.store, runner, {
    releaseSha: options.releaseSha,
    adapterVersion: options.adapterVersion,
    maxPerCycle: 1
  });
  const telegram = telegramAdapterFromEnv(env);
  const projector = telegram ? new DiagnosisNotificationProjector(options.store, telegram.channelKey) : undefined;
  const dispatcher = telegram ? new NotificationDispatcher(options.store, [telegram]) : undefined;
  return new WorkspaceAutoDiagnosisLifecycle(coordinator, projector, dispatcher);
}

/** Operations facts remain authoritative; diagnosis is an additional fail-soft post-projection phase. */
export class AutoDiagnosingRuntimeOperationsAdapter implements RuntimeOperationsPort {
  constructor(private readonly inner: RuntimeOperationsPort, private readonly diagnosis: AutoDiagnosisRunner) {}

  async projectAndNotify(now: string): Promise<RuntimeOperationsReport> {
    const report = await this.inner.projectAndNotify(now);
    try { await this.diagnosis.run(now); }
    catch { /* diagnosis availability never turns a healthy publishing cycle red */ }
    return report;
  }
}
