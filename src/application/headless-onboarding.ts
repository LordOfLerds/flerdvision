import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { JsonDistributionConfigurationStore } from "../adapters/distribution/json-config-store.js";
import { FileDriveCredentialStore } from "../adapters/ingress/google-drive/drive-credentials.js";
import { WorkspaceSourceActivationCommands } from "../adapters/runtime/workspace-source-activation.js";
import type { SourceActivationStatus } from "../domain/source-activation-ports.js";
import type { WorkspaceSpecV1 } from "../domain/workspace-spec.js";
import { bootstrapHeadlessWorkspace, type HeadlessBootstrapResult } from "./headless-bootstrap.js";
import { inspectHeadlessWorkspace, type HeadlessDoctorReport } from "./headless-status.js";
import { extractGoogleDriveFolderId, type SourceTopology } from "./source-structure-discovery.js";

export type OnboardingStage =
  | "SPEC_VALIDATED"
  | "DRIVE_CONNECTED"
  | "ROOT_CONFIRMED"
  | "TOPOLOGY_CONFIRMED"
  | "ACTIVATION_CONFIRMED"
  | "ACCOUNTS_LOGGED_IN"
  | "TELEGRAM_TESTED"
  | "READY";

export interface OnboardingStreamView {
  customerName: string;
  channelName: string;
  platform: string;
  format: string;
  folderPath: string;
  matchedBy: "explicit" | "semantic" | "root_fallback";
  videoCount: number;
}

export interface HeadlessOnboardingStatus {
  workspaceName: string;
  sourceKind: WorkspaceSpecV1["source"]["kind"];
  sourceRoot: string;
  activationMode: WorkspaceSpecV1["source"]["activation"];
  stage: OnboardingStage;
  driveConnected: boolean;
  rootConfirmed: boolean;
  topologyVerified: boolean;
  topologyConfirmed: boolean;
  activationConfirmed: boolean;
  accountsLoggedIn: boolean;
  telegramConfigured: boolean;
  telegramTested: boolean;
  ready: boolean;
  streams: readonly OnboardingStreamView[];
  warnings: readonly string[];
  nextAction?: string;
}

interface PersistedOnboardingState {
  schemaVersion: 1;
  rootFingerprint?: string;
  rootConfirmedAt?: string;
  topologyFingerprint?: string;
  topologyConfirmedAt?: string;
  activationFingerprint?: string;
  activationConfirmedAt?: string;
  telegramFingerprint?: string;
  telegramTestedAt?: string;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function nowIso(value?: string): string {
  return new Date(value ?? new Date().toISOString()).toISOString();
}

function rootFingerprint(spec: WorkspaceSpecV1, topology: SourceTopology): string {
  const stableRoot = spec.source.kind === "google_drive" ? extractGoogleDriveFolderId(spec.source.root) : resolve(spec.source.root);
  return digest(JSON.stringify({ kind: spec.source.kind, root: stableRoot, discoveredRoot: topology.rootId }));
}

function topologyFingerprint(topology: SourceTopology): string {
  return digest(JSON.stringify([...topology.streams]
    .map((stream) => ({ channelKey: stream.channelKey, platform: stream.platform, format: stream.format, folderRef: stream.folderRef, matchedBy: stream.matchedBy }))
    .sort((a, b) => `${a.channelKey}|${a.format}`.localeCompare(`${b.channelKey}|${b.format}`))));
}

function activationFingerprint(bootstrap: HeadlessBootstrapResult): string {
  const stored = new JsonDistributionConfigurationStore(resolve(bootstrap.configDir, "distribution.json")).load();
  return digest(JSON.stringify(stored.config.activationCursors
    .map((cursor) => ({ laneId: cursor.laneId, mode: cursor.mode, activatedAt: cursor.activatedAt, since: cursor.since, selected: cursor.selectedExternalObjectIds }))
    .sort((a, b) => a.laneId.localeCompare(b.laneId))));
}

function telegramFingerprint(env: Record<string, string | undefined>): string | undefined {
  const bot = env.FLERDVISION_TELEGRAM_BOT_TOKEN?.trim();
  const chat = env.FLERDVISION_TELEGRAM_CHAT_ID?.trim();
  if (!bot || !chat) return undefined;
  // Persist only a one-way fingerprint; neither token nor chat id is written to onboarding.json.
  return digest(`${digest(bot)}|${digest(chat)}`);
}

class OnboardingStateStore {
  private readonly path: string;
  constructor(configDir: string) { this.path = resolve(configDir, "onboarding.json"); }

  read(): PersistedOnboardingState {
    if (!existsSync(this.path)) return { schemaVersion: 1 };
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as PersistedOnboardingState;
      return parsed?.schemaVersion === 1 ? parsed : { schemaVersion: 1 };
    } catch { return { schemaVersion: 1 }; }
  }

  write(value: PersistedOnboardingState): void {
    const temp = `${this.path}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temp, this.path);
  }
}

function accountLoginReady(report: HeadlessDoctorReport): boolean {
  return report.channels.length > 0 && report.channels.every((channel) =>
    channel.accountRegistered && channel.identityRegistered && channel.latestSessionState === "HEALTHY"
  );
}

function streamViews(spec: WorkspaceSpecV1, topology: SourceTopology): readonly OnboardingStreamView[] {
  const customers = new Map(spec.customers.map((customer) => [customer.key, customer.name]));
  const channels = new Map(spec.channels.map((channel) => [channel.key, channel]));
  return topology.streams.map((stream) => {
    const channel = channels.get(stream.channelKey);
    return {
      customerName: channel ? customers.get(channel.customerKey) ?? channel.customerKey : stream.channelKey,
      channelName: channel?.name ?? stream.channelKey,
      platform: stream.platform,
      format: stream.format,
      folderPath: stream.folderPath,
      matchedBy: stream.matchedBy,
      videoCount: stream.totalVideoCount
    };
  });
}

function stageFor(input: Omit<HeadlessOnboardingStatus, "stage" | "ready" | "nextAction">): { stage: OnboardingStage; nextAction?: string } {
  if (!input.driveConnected) return { stage: "SPEC_VALIDATED", nextAction: "Google Drive verbinden: flerdvision drive-auth" };
  if (!input.rootConfirmed) return { stage: "DRIVE_CONNECTED", nextAction: "Root prüfen und bestätigen: flerdvision setup confirm-root" };
  if (!input.topologyVerified || !input.topologyConfirmed) return { stage: "ROOT_CONFIRMED", nextAction: "Ordnerzuordnung prüfen und bestätigen: flerdvision setup confirm-topology" };
  if (!input.activationConfirmed) return { stage: "TOPOLOGY_CONFIRMED", nextAction: `Aktivierung ${input.activationMode} bestätigen: flerdvision setup activate` };
  if (!input.accountsLoggedIn) return { stage: "ACTIVATION_CONFIRMED", nextAction: "Social-Accounts einloggen; danach setup status erneut prüfen" };
  if (!input.telegramTested) return { stage: "ACCOUNTS_LOGGED_IN", nextAction: input.telegramConfigured ? "Telegram testen: flerdvision notify-test" : "Telegram Bot/Chat konfigurieren und notify-test ausführen" };
  return { stage: "READY" };
}

/**
 * Resumable setup state derived from real workspace facts plus three human confirmations. The file
 * never stores OAuth/Telegram secrets. Root/topology confirmations automatically become stale when
 * their fingerprints change, so a Drive move/remap cannot stay silently approved forever.
 */
export class HeadlessOnboardingService {
  constructor(private readonly input: { specPath: string; releaseSha: string; env?: Record<string, string | undefined> }) {}

  private get env(): Record<string, string | undefined> { return this.input.env ?? process.env; }

  private async snapshot(now?: string): Promise<{ bootstrap: HeadlessBootstrapResult; doctor: HeadlessDoctorReport; persisted: PersistedOnboardingState }> {
    const at = nowIso(now);
    const bootstrap = await bootstrapHeadlessWorkspace({ specPath: this.input.specPath, env: this.env, now: at });
    const doctor = inspectHeadlessWorkspace({ specPath: this.input.specPath, releaseSha: this.input.releaseSha, env: this.env, now: at });
    const persisted = new OnboardingStateStore(bootstrap.configDir).read();
    return { bootstrap, doctor, persisted };
  }

  async status(now?: string): Promise<HeadlessOnboardingStatus> {
    const { bootstrap, doctor, persisted } = await this.snapshot(now);
    const spec = bootstrap.spec;
    const driveConnected = spec.source.kind !== "google_drive" || new FileDriveCredentialStore(bootstrap.configDir).status().connected;
    const rootFp = rootFingerprint(spec, bootstrap.topology);
    const topologyFp = topologyFingerprint(bootstrap.topology);
    const activationFp = activationFingerprint(bootstrap);
    const telegramFp = telegramFingerprint(this.env);
    const base = {
      workspaceName: spec.workspace.name,
      sourceKind: spec.source.kind,
      sourceRoot: bootstrap.topology.rootPath,
      activationMode: spec.source.activation,
      driveConnected,
      rootConfirmed: persisted.rootFingerprint === rootFp,
      topologyVerified: bootstrap.topology.verified,
      topologyConfirmed: bootstrap.topology.verified && persisted.topologyFingerprint === topologyFp,
      activationConfirmed: persisted.activationFingerprint === activationFp,
      accountsLoggedIn: accountLoginReady(doctor),
      telegramConfigured: Boolean(telegramFp),
      telegramTested: Boolean(telegramFp && persisted.telegramFingerprint === telegramFp),
      streams: streamViews(spec, bootstrap.topology),
      warnings: bootstrap.topology.warnings
    };
    const stage = stageFor(base);
    return { ...base, stage: stage.stage, ready: stage.stage === "READY", ...(stage.nextAction ? { nextAction: stage.nextAction } : {}) };
  }

  async confirmRoot(now?: string): Promise<HeadlessOnboardingStatus> {
    const at = nowIso(now);
    const { bootstrap, persisted } = await this.snapshot(at);
    if (!bootstrap.topology.verified) throw new Error("Source root kann erst nach erfolgreicher Drive-Verbindung bestätigt werden.");
    const store = new OnboardingStateStore(bootstrap.configDir);
    const rootFp = rootFingerprint(bootstrap.spec, bootstrap.topology);
    // A root change invalidates every dependent confirmation below it.
    store.write({ schemaVersion: 1, ...persisted, rootFingerprint: rootFp, rootConfirmedAt: at, topologyFingerprint: undefined, topologyConfirmedAt: undefined, activationFingerprint: undefined, activationConfirmedAt: undefined });
    return await this.status(at);
  }

  async confirmTopology(now?: string): Promise<HeadlessOnboardingStatus> {
    const at = nowIso(now);
    const { bootstrap, persisted } = await this.snapshot(at);
    if (!bootstrap.topology.verified) throw new Error("Ordnerzuordnung ist noch nicht verifiziert.");
    const currentRoot = rootFingerprint(bootstrap.spec, bootstrap.topology);
    if (persisted.rootFingerprint !== currentRoot) throw new Error("Source root muss zuerst auf dem aktuellen Stand bestätigt werden.");
    const store = new OnboardingStateStore(bootstrap.configDir);
    store.write({ schemaVersion: 1, ...persisted, topologyFingerprint: topologyFingerprint(bootstrap.topology), topologyConfirmedAt: at, activationFingerprint: undefined, activationConfirmedAt: undefined });
    return await this.status(at);
  }

  async activate(now?: string): Promise<HeadlessOnboardingStatus> {
    const at = nowIso(now);
    const { bootstrap, persisted } = await this.snapshot(at);
    if (!bootstrap.topology.verified) throw new Error("Source topology ist noch nicht verifiziert.");
    if (persisted.rootFingerprint !== rootFingerprint(bootstrap.spec, bootstrap.topology)) throw new Error("Source root muss zuerst bestätigt werden.");
    if (persisted.topologyFingerprint !== topologyFingerprint(bootstrap.topology)) throw new Error("Ordnerzuordnung muss zuerst bestätigt werden.");

    const config = new JsonDistributionConfigurationStore(resolve(bootstrap.configDir, "distribution.json")).load();
    const activation = new WorkspaceSourceActivationCommands({ runtimeRoot: bootstrap.runtimeRoot, workspaceId: bootstrap.spec.workspace.id, env: this.env });
    try {
      for (const lane of config.config.lanes.filter((item) => item.enabled)) {
        const status: SourceActivationStatus = activation.status(lane.laneId);
        if (status.state === "CAPTURED" || status.state === "NOT_REQUIRED") continue;
        if (status.state !== "MISSING_BASELINE") throw new Error(`Aktivierung für ${lane.displayName} ist nicht bereit: ${status.reason ?? status.state}`);
        const preview = await activation.previewBaseline(lane.laneId, at);
        await activation.captureBaseline(lane.laneId, at, preview.snapshotFingerprint);
      }
    } finally { activation.close(); }

    const store = new OnboardingStateStore(bootstrap.configDir);
    store.write({ ...persisted, schemaVersion: 1, activationFingerprint: activationFingerprint(bootstrap), activationConfirmedAt: at });
    return await this.status(at);
  }

  async markTelegramTested(now?: string): Promise<HeadlessOnboardingStatus> {
    const at = nowIso(now);
    const { bootstrap, persisted } = await this.snapshot(at);
    const fingerprint = telegramFingerprint(this.env);
    if (!fingerprint) throw new Error("Telegram Bot/Chat ist nicht vollständig konfiguriert.");
    new OnboardingStateStore(bootstrap.configDir).write({ ...persisted, schemaVersion: 1, telegramFingerprint: fingerprint, telegramTestedAt: at });
    return await this.status(at);
  }
}
