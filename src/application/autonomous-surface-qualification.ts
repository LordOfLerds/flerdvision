import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { AccountIdentityGuard, BrowserSessionHealthService } from "./browser-identity-service.js";
import { buildCalibrationReplayPlan } from "./platform-execution-plan.js";
import { PlatformSurfaceRegistryService } from "./platform-surface-registry.js";
import { workspaceRuntimeLayout } from "./workspaces.js";
import type { DistributionPostingContext } from "../domain/distribution-publish-ports.js";
import type { BrowserIdentity } from "../domain/browser-identity.js";
import type { PublicationIntent, PublishAttempt } from "../domain/model.js";
import type { StoredSurfaceContractVersion } from "../domain/platform-surface-ports.js";
import type { PrepareArtifactSinkPort } from "../domain/platform-ui-ports.js";
import type { RouteTestEvidenceKey, RouteTestEvidenceRecord } from "../domain/route-test-ports.js";
import { ChromiumCdpRuntimeAdapter } from "../adapters/browser/chromium-cdp.js";
import { ConfiguredDomSessionProbe } from "../adapters/browser/configured-dom-probe.js";
import { commandSurfaceAgentFromEnv } from "../adapters/browser/command-surface-agent.js";
import { AutonomousSurfaceExplorer } from "../adapters/browser/autonomous-surface-explorer.js";
import { AutonomousSurfaceSettings } from "../adapters/browser/autonomous-surface-settings.js";
import { LocalPrepareArtifactSink } from "../adapters/browser/prepare-artifacts.js";
import { SafePlatformExecutionRunner } from "../adapters/browser/platform-execution-runner.js";
import { BrowserProfileDirectoryResolver, DurableBrowserProfileLockAdapter, FileBrowserProfileLockAdapter } from "../adapters/browser/profile-lock.js";
import { resolveChromiumExecutablePath } from "../adapters/browser/resolve-chromium.js";
import { calibratedSessionProbeFor, loadSessionProbeConfigFile } from "../adapters/browser/session-probe-config.js";
import { JsonDistributionConfigurationStore } from "../adapters/distribution/json-config-store.js";
import { SqlitePlatformSurfaceStore } from "../adapters/distribution/sqlite-surface-store.js";
import { SqliteDistributionRuntimeStateStore } from "../adapters/distribution/sqlite-runtime-state.js";
import { SqliteRouteTestEvidenceStore } from "../adapters/distribution/sqlite-route-test-evidence.js";
import { workspaceDriveAccessTokenProvider } from "../adapters/ingress/google-drive/workspace-drive-token.js";
import { WorkspaceMediaMaterializer } from "../adapters/publish/workspace-media-materializer.js";
import { WorkspacePublicationPayloadResolver } from "../adapters/publish/workspace-payload-resolver.js";
import { SqliteControlPlaneStore } from "../adapters/storage/sqlite.js";
import { LocalVerificationArtifactSink } from "../adapters/verify/artifacts.js";
import { DeclarativeProfileVerificationCollector } from "../adapters/verify/profile.js";
import { loadProfileVerificationSpecFile } from "../adapters/verify/profile-spec-config.js";

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function isoAt(base: string, offsetMs: number): string { return new Date(new Date(base).getTime() + offsetMs).toISOString(); }
function safe(value: string): string { return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "artifact"; }
function atomicJson(path: string, value: unknown): void {
  const temp = `${path}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temp, path);
}
function writeEvidence(root: string, label: string, payload: unknown): string {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = join(root, `${safe(label)}-${Date.now().toString(36)}.json`);
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return path;
}
function evidenceId(routeId: string, key: RouteTestEvidenceKey, checkedAt: string, summary: string): string {
  return `route-test:${hash(`${routeId}|${key}|${checkedAt}|${summary}`).slice(0, 24)}`;
}

class IdentityBoundPrepareArtifacts implements PrepareArtifactSinkPort {
  constructor(private readonly inner: PrepareArtifactSinkPort, private readonly identity: BrowserIdentity) {}
  captureBoundary(session: Parameters<PrepareArtifactSinkPort["captureBoundary"]>[0], intent: PublicationIntent, _identity: BrowserIdentity, label: string, now: string) {
    return this.inner.captureBoundary(session, intent, this.identity, label, now);
  }
  writeJournal(intent: PublicationIntent, entries: readonly unknown[], now: string) { return this.inner.writeJournal(intent, entries, now); }
}

function markVerificationCalibrated(path: string, accountId: string, platform: PublicationIntent["platform"], at: string): void {
  const raw = JSON.parse(readFileSync(path, "utf8")) as { schemaVersion: number; specs: Record<string, unknown>[] };
  let changed = false;
  const specs = raw.specs.map((entry) => {
    if (entry.accountId !== accountId || entry.platform !== platform) return entry;
    changed = true;
    return { ...entry, calibrationStatus: "CALIBRATED", calibratedAt: at, calibratedBy: "headless-autonomous-qualification" };
  });
  if (!changed) throw new Error(`Profile verification config has no entry for ${platform}/${accountId}`);
  atomicJson(path, { schemaVersion: 1, specs });
}

export interface AutonomousRouteQualificationResult {
  routeId: string;
  accountId: string;
  platform: PublicationIntent["platform"];
  format: PublicationIntent["format"];
  assetId: string;
  surfaceContractId: string;
  prepareOnlyPasses: number;
  verificationEvidence: number;
  artifactRefs: readonly string[];
}

export class AutonomousRouteQualifier {
  private readonly layout: ReturnType<typeof workspaceRuntimeLayout>;
  private readonly config: JsonDistributionConfigurationStore;
  private readonly control: SqliteControlPlaneStore;
  private readonly state: SqliteDistributionRuntimeStateStore;
  private readonly surfaces: SqlitePlatformSurfaceStore;
  private readonly routeEvidence: SqliteRouteTestEvidenceStore;
  private readonly registry: PlatformSurfaceRegistryService;
  private readonly runtime: ChromiumCdpRuntimeAdapter;
  private readonly locks: DurableBrowserProfileLockAdapter;
  private readonly env: Record<string, string | undefined>;

  constructor(private readonly options: {
    runtimeRoot: string;
    workspaceId: string;
    releaseSha: string;
    env?: Record<string, string | undefined>;
    chromiumExecutablePath?: string;
    headless?: boolean;
  }) {
    if (!options.releaseSha.trim()) throw new Error("Autonomous route qualification requires an exact release SHA");
    this.env = options.env ?? process.env;
    this.layout = workspaceRuntimeLayout(resolve(options.runtimeRoot), options.workspaceId);
    this.config = new JsonDistributionConfigurationStore(resolve(this.layout.configDir, "distribution.json"));
    this.control = new SqliteControlPlaneStore(this.layout.databasePath);
    this.state = new SqliteDistributionRuntimeStateStore(this.layout.databasePath);
    this.surfaces = new SqlitePlatformSurfaceStore(this.layout.databasePath);
    this.routeEvidence = new SqliteRouteTestEvidenceStore(this.layout.databasePath);
    this.registry = new PlatformSurfaceRegistryService(this.surfaces);
    const executablePath = options.chromiumExecutablePath ?? this.env.CHROMIUM_EXECUTABLE_PATH ?? resolveChromiumExecutablePath();
    this.runtime = new ChromiumCdpRuntimeAdapter({ profilesRoot: this.layout.profilesDir, executablePath });
    const resolver = new BrowserProfileDirectoryResolver(this.layout.profilesDir);
    this.locks = new DurableBrowserProfileLockAdapter(this.control, new FileBrowserProfileLockAdapter(resolver));
  }

  private routeContext(routeId: string) {
    const stored = this.config.load();
    const route = stored.config.routes.find((item) => item.routeId === routeId);
    if (!route || !route.enabled) throw new Error(`Route ${routeId} is missing or disabled`);
    const postingProfile = stored.config.postingProfiles.find((item) => item.postingProfileId === route.postingProfileId);
    const copyProfile = stored.config.copyProfiles.find((item) => item.copyProfileId === route.copyProfileId);
    const lane = stored.config.lanes.find((item) => item.laneId === route.laneId);
    if (!postingProfile?.enabled || !copyProfile?.enabled || !lane?.enabled) throw new Error(`Route ${routeId} has incomplete profile/copy/lane configuration`);
    const assets = this.state.listAssets().map((item) => item.asset).filter((asset) => asset.laneId === route.laneId && asset.state === "READY").sort((a, b) => a.observedAt.localeCompare(b.observedAt));
    const asset = assets[0];
    if (!asset) throw new Error(`Route ${routeId} has no READY source asset`);
    const content = this.control.getContentItem(asset.contentId)?.item;
    if (!content) throw new Error(`READY asset ${asset.assetId} has no durable content item`);
    const identities = this.control.listBrowserIdentities().map((item) => item.identity).filter((identity) => identity.accountId === route.accountId && identity.enabled);
    if (identities.length !== 1) throw new Error(`Route ${routeId} requires exactly one enabled browser identity; found ${identities.length}`);
    const identity = identities[0]!;
    const account = this.control.getSocialAccount(route.accountId)?.account;
    if (!account?.enabled) throw new Error(`Route ${routeId} account is missing or disabled`);
    if (account.platform !== route.platform || identity.platform !== route.platform) throw new Error(`Route ${routeId} account/identity platform mismatch`);
    const intent: PublicationIntent = {
      intentId: `qualification:${hash(`${routeId}|${asset.assetId}|${this.options.releaseSha}`).slice(0, 24)}`,
      contentId: asset.contentId,
      creatorId: asset.creatorId,
      platform: route.platform,
      accountId: route.accountId,
      format: postingProfile.format,
      copyVersionId: copyProfile.versionId,
      scheduledFor: new Date().toISOString(),
      idempotencyKey: `qualification:${routeId}:${asset.assetId}:${this.options.releaseSha}`
    };
    const context: DistributionPostingContext = {
      intent,
      postingProfile,
      provenance: {
        planId: `qualification-plan:${routeId}`,
        deliveryId: `qualification-delivery:${routeId}:${asset.assetId}`,
        routeId,
        laneId: route.laneId,
        assetId: asset.assetId,
        postingProfileId: route.postingProfileId,
        copyProfileId: route.copyProfileId,
        schedulePolicyId: route.schedulePolicyId,
        routeSnapshotFingerprint: `qualification:${hash(JSON.stringify(route)).slice(0, 24)}`,
        postingProfileSnapshot: postingProfile
      }
    };
    return { stored, route, postingProfile, copyProfile, lane, asset, content, identity, account, intent, context };
  }

  private record(routeId: string, key: RouteTestEvidenceKey, checkedAt: string, summary: string, artifactRefs: readonly string[], surfaceContractId?: string): RouteTestEvidenceRecord {
    if (artifactRefs.length === 0) throw new Error(`Passing ${key} evidence requires at least one durable artifact reference`);
    return this.routeEvidence.record({ evidenceId: evidenceId(routeId, key, checkedAt, summary), routeId, testKey: key, status: "PASS", checkedAt, releaseSha: this.options.releaseSha, ...(surfaceContractId ? { surfaceContractId } : {}), summary, artifactRefs: [...artifactRefs] });
  }

  async qualify(routeId: string, now = new Date().toISOString()): Promise<AutonomousRouteQualificationResult> {
    const at = new Date(now).toISOString();
    const ctx = this.routeContext(routeId);
    const probePath = resolve(this.layout.configDir, "session-probes.json");
    const probeEntry = calibratedSessionProbeFor(loadSessionProbeConfigFile(probePath), ctx.route.accountId, ctx.route.platform);
    if (!probeEntry) throw new Error(`Channel ${ctx.route.accountId} has no calibrated session probe; run the one-time login step first`);
    const driveToken = workspaceDriveAccessTokenProvider({ configDir: this.layout.configDir, env: this.env });
    const media = new WorkspaceMediaMaterializer(this.config, driveToken, resolve(this.layout.mediaCacheDir, "headless-qualification"));
    const payloadResolver = new WorkspacePublicationPayloadResolver(resolve(this.layout.configDir, "copy-payloads.json"), this.control);
    const artifactSink = new LocalPrepareArtifactSink(resolve(this.layout.evidenceDir, "headless", "surface"));
    const boundArtifacts = new IdentityBoundPrepareArtifacts(artifactSink, ctx.identity);
    const sourceEvidenceRoot = resolve(this.layout.evidenceDir, "headless", "qualification");
    const artifact = await media.materialize(ctx.content);
    const payload = await payloadResolver.resolve(ctx.intent);
    const allArtifacts: string[] = [];
    try {
      const sourceRef = writeEvidence(sourceEvidenceRoot, `${routeId}-source`, {
        checkedAt: at,
        routeId,
        assetId: ctx.asset.assetId,
        contentId: ctx.content.contentId,
        mediaSha256: artifact.sha256,
        mediaSizeBytes: artifact.sizeBytes,
        sourceRef: artifact.sourceRef
      });
      this.record(routeId, "SOURCE", at, `READY asset ${ctx.asset.assetId} materialized and hashed`, [sourceRef]);
      allArtifacts.push(sourceRef);

      const ownerId = `headless-surface-discovery:${routeId}`;
      const lock = this.locks.acquire(ctx.identity, ownerId, at);
      let session: Awaited<ReturnType<ChromiumCdpRuntimeAdapter["launch"]>> | undefined;
      let recordedContract: StoredSurfaceContractVersion | undefined;
      try {
        session = await this.runtime.launch(ctx.identity, { headless: this.options.headless ?? false, initialUrl: "about:blank" });
        const health = await new BrowserSessionHealthService(this.control, new ConfiguredDomSessionProbe(probeEntry.config)).check(ctx.identity.identityId, session, at, { type: "operator", id: ownerId });
        if (health.state !== "HEALTHY") {
          // The probe records WHY (its note and the URL it saw); discarding that turned every
          // diagnosis into a guessing game during the real acceptance.
          throw new Error(`Session is not healthy: ${health.state}${health.note ? ` · ${health.note}` : ""}${health.currentUrl ? ` · at ${health.currentUrl}` : ""}`);
        }
        const proven = new AccountIdentityGuard(this.control).assertReady(ctx.identity.identityId);
        const identityArtifacts = await artifactSink.captureBoundary(session, ctx.intent, ctx.identity, "qualification-session-identity", at);
        this.record(routeId, "SESSION", isoAt(at, 1), `Persistent session is HEALTHY for ${ctx.identity.identityId}`, identityArtifacts);
        this.record(routeId, "IDENTITY", isoAt(at, 2), `Observed @${proven.observedHandle ?? ctx.identity.expectedHandle} matches target identity`, identityArtifacts);
        allArtifacts.push(...identityArtifacts);

        const agent = commandSurfaceAgentFromEnv(this.env) ?? undefined;
        const explorer = new AutonomousSurfaceExplorer(session, boundArtifacts, agent);
        const explored = await explorer.discoverAndPrepare({ intent: ctx.intent, identity: ctx.identity, postingProfile: ctx.postingProfile, mediaPath: artifact.localPath, ...(payload.caption !== undefined ? { caption: payload.caption } : {}), ...(payload.title !== undefined ? { title: payload.title } : {}) });
        const settings = await new AutonomousSurfaceSettings(session, artifactSink, agent).enrich({ contract: explored.contract, intent: ctx.intent, identity: ctx.identity, postingProfile: ctx.postingProfile });
        recordedContract = this.surfaces.recordContract(settings.contract, isoAt(at, 3));
        allArtifacts.push(...explored.artifactRefs, ...settings.artifactRefs);
      } finally {
        if (session) await session.close().catch(() => {});
        lock.release();
      }
      if (!recordedContract) throw new Error("Autonomous surface discovery did not produce a durable contract");

      const replayArtifacts: string[] = [];
      for (let index = 0; index < 3; index += 1) {
        const replayAt = isoAt(at, 10_000 + index * 10_000);
        const owner = `headless-surface-replay:${routeId}:${index + 1}`;
        const replayLock = this.locks.acquire(ctx.identity, owner, replayAt);
        let replaySession: Awaited<ReturnType<ChromiumCdpRuntimeAdapter["launch"]>> | undefined;
        try {
          replaySession = await this.runtime.launch(ctx.identity, { headless: this.options.headless ?? false, initialUrl: "about:blank" });
          const health = await new BrowserSessionHealthService(this.control, new ConfiguredDomSessionProbe(probeEntry.config)).check(ctx.identity.identityId, replaySession, replayAt, { type: "worker", id: owner });
          if (health.state !== "HEALTHY") throw new Error(`Replay session is not healthy: ${health.state}${health.note ? ` · ${health.note}` : ""}${health.currentUrl ? ` · at ${health.currentUrl}` : ""}`);
          new AccountIdentityGuard(this.control).assertReady(ctx.identity.identityId);
          let tick = 0;
          const execution = await new SafePlatformExecutionRunner(replaySession, boundArtifacts, () => isoAt(replayAt, tick++)).execute(
            buildCalibrationReplayPlan(ctx.context, recordedContract.contract),
            ctx.identity,
            { mediaPath: artifact.localPath, ...(payload.caption !== undefined ? { caption: payload.caption } : {}), ...(payload.title !== undefined ? { title: payload.title } : {}) }
          );
          const passed = execution.environmentFingerprint === recordedContract.contract.environment.fingerprint && execution.reachedFinalActionBoundary && !execution.finalActionInvoked;
          const evidence = this.registry.recordReplay({
            replayId: `surface-replay:${recordedContract.contract.contractId}:${index + 1}:${hash(replayAt).slice(0, 8)}`,
            contractId: recordedContract.contract.contractId,
            checkedAt: replayAt,
            passed,
            reachedFinalActionBoundary: execution.reachedFinalActionBoundary,
            finalActionInvoked: execution.finalActionInvoked,
            environmentFingerprint: execution.environmentFingerprint,
            artifactRefs: [...execution.artifactRefs]
          });
          if (!evidence.passed) throw new Error(`Prepare-only replay ${index + 1} did not match the recorded surface environment`);
          this.record(routeId, "PREPARE_ONLY", replayAt, `Autonomous prepare-only replay ${index + 1}/3 reached final boundary without publishing`, evidence.artifactRefs, recordedContract.contract.contractId);
          replayArtifacts.push(...evidence.artifactRefs);
        } finally {
          if (replaySession) await replaySession.close().catch(() => {});
          replayLock.release();
        }
      }
      allArtifacts.push(...replayArtifacts);
      const calibrated = this.registry.qualify(ctx.route.accountId, ctx.postingProfile, isoAt(at, 45_000));
      const surfaceRef = writeEvidence(sourceEvidenceRoot, `${routeId}-surface`, { checkedAt: isoAt(at, 45_000), contract: calibrated.contract, versionId: calibrated.versionId });
      this.record(routeId, "SURFACE", isoAt(at, 45_001), `Surface ${calibrated.contract.contractId} calibrated from three autonomous replays`, [surfaceRef, ...replayArtifacts.slice(-3)], calibrated.contract.contractId);
      allArtifacts.push(surfaceRef);

      const verificationPath = resolve(this.layout.configDir, "profile-verification.json");
      const verificationEntry = loadProfileVerificationSpecFile(verificationPath).specs.find((entry) => entry.platform === ctx.intent.platform && entry.accountId === ctx.intent.accountId);
      if (!verificationEntry) throw new Error(`No profile verification contract exists for ${ctx.intent.platform}/${ctx.intent.accountId}`);
      const attemptAt = isoAt(at, 50_000);
      const attempt: PublishAttempt = {
        attemptId: `qualification-verification:${hash(`${routeId}|${attemptAt}`).slice(0, 24)}`,
        intentId: ctx.intent.intentId,
        browserIdentityId: ctx.identity.identityId,
        releaseSha: this.options.releaseSha,
        startedAt: attemptAt,
        finishedAt: attemptAt,
        result: "prepared",
        reachedFinalActionBoundary: true
      };
      const verificationArtifacts = new LocalVerificationArtifactSink(resolve(this.layout.evidenceDir, "headless", "verification"));
      const collector = new DeclarativeProfileVerificationCollector(
        this.control,
        this.runtime,
        this.locks,
        new ConfiguredDomSessionProbe(probeEntry.config),
        verificationArtifacts,
        verificationEntry.spec,
        { ownerId: `headless-verification:${routeId}`, headless: this.options.headless ?? false, now: () => attemptAt }
      );
      const verificationEvidence = await collector.collect(ctx.intent, attempt);
      const verificationRefs = verificationEvidence.flatMap((item) => item.artifactRef ? [item.artifactRef] : []);
      if (verificationEvidence.length === 0 || verificationRefs.length === 0) throw new Error("Verification surface produced no durable evidence");
      markVerificationCalibrated(verificationPath, ctx.intent.accountId, ctx.intent.platform, attemptAt);
      this.record(routeId, "VERIFICATION", attemptAt, `Profile verification surface is reachable and produced ${verificationEvidence.length} deterministic evidence record(s)`, verificationRefs, calibrated.contract.contractId);
      allArtifacts.push(...verificationRefs);

      this.state.putRouteTestReadiness({
        routeId,
        sourcePassed: true,
        sessionPassed: true,
        identityPassed: true,
        prepareOnlyPasses: 3,
        secretLivePassed: false,
        verificationPassed: true,
        cleanupPassed: false,
        releaseSha: this.options.releaseSha,
        surfaceContractId: calibrated.contract.contractId
      }, isoAt(at, 50_001));

      return {
        routeId,
        accountId: ctx.route.accountId,
        platform: ctx.route.platform,
        format: ctx.postingProfile.format,
        assetId: ctx.asset.assetId,
        surfaceContractId: calibrated.contract.contractId,
        prepareOnlyPasses: 3,
        verificationEvidence: verificationEvidence.length,
        artifactRefs: allArtifacts
      };
    } finally {
      await media.release(artifact).catch(() => {});
    }
  }

  routes(): readonly string[] { return this.config.load().config.routes.filter((route) => route.enabled).map((route) => route.routeId); }
  close(): void { this.routeEvidence.close(); this.surfaces.close(); this.state.close(); this.control.close(); }
}
