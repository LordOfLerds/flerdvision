import type { BrowserIdentityStorePort, BrowserPageSessionPort, BrowserProfileLock, BrowserProfileLockPort, BrowserRuntimePort, SessionProbePort } from "../domain/browser-identity-ports.js";
import { AccountIdentityGuard, BrowserSessionHealthService } from "./browser-identity-service.js";
import type { IngressStorePort } from "../domain/ingress-ports.js";
import type { PublicationIntent, PublishAttempt } from "../domain/model.js";
import type { PlatformCapabilityStorePort, MediaMaterializerPort, PlatformUiAdapterPort, PrepareArtifactSinkPort, PublicationPayloadResolverPort } from "../domain/platform-ui-ports.js";
import type { LocalMediaArtifact, PlatformCapability } from "../domain/platform-ui.js";

export class PlatformCapabilityMissingError extends Error {}
export class PlatformAdapterMissingError extends Error {}

type PrepareStore = BrowserIdentityStorePort & IngressStorePort & PlatformCapabilityStorePort;

export interface PlatformPreparationOptions {
  releaseSha: string;
  ownerId: string;
  headless?: boolean;
  now?: () => string;
}

function attemptId(intentId: string, now: string): string {
  return `attempt:${intentId}:${new Date(now).getTime().toString(36)}:${Math.random().toString(36).slice(2, 9)}`;
}

export interface PreparedPlatformSession {
  attempt: PublishAttempt;
  session: BrowserPageSessionPort;
  media: LocalMediaArtifact;
  adapter: PlatformUiAdapterPort;
  identityId: string;
  close(): Promise<void>;
}

export class PlatformPreparationCoordinator {
  private readonly adapters = new Map<PublicationIntent["platform"], PlatformUiAdapterPort>();
  private readonly now: () => string;

  constructor(
    private readonly store: PrepareStore,
    private readonly browserRuntime: BrowserRuntimePort,
    private readonly profileLocks: BrowserProfileLockPort,
    private readonly sessionProbes: Readonly<Partial<Record<PublicationIntent["platform"], SessionProbePort>>>,
    private readonly payloadResolver: PublicationPayloadResolverPort,
    private readonly mediaMaterializer: MediaMaterializerPort,
    private readonly artifacts: PrepareArtifactSinkPort,
    platformAdapters: readonly PlatformUiAdapterPort[],
    private readonly options: PlatformPreparationOptions
  ) {
    for (const adapter of platformAdapters) {
      if (this.adapters.has(adapter.platform)) throw new Error(`Duplicate platform adapter: ${adapter.platform}`);
      this.adapters.set(adapter.platform, adapter);
    }
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async open(intent: PublicationIntent): Promise<PreparedPlatformSession> {
    const startedAt = this.now();
    const account = this.store.getSocialAccount(intent.accountId);
    if (!account) throw new Error(`Unknown social account: ${intent.accountId}`);
    if (account.account.platform !== intent.platform) throw new Error(`Intent platform ${intent.platform} does not match account platform ${account.account.platform}`);
    const identityRecord = this.store.listBrowserIdentities().find((candidate) => candidate.identity.accountId === intent.accountId);
    if (!identityRecord) throw new Error(`No browser identity for account ${intent.accountId}`);
    const identity = identityRecord.identity;
    const adapter = this.adapters.get(intent.platform);
    if (!adapter) throw new PlatformAdapterMissingError(`No UI adapter configured for ${intent.platform}`);
    const probe = this.sessionProbes[intent.platform];
    if (!probe) throw new PlatformAdapterMissingError(`No session probe configured for ${intent.platform}`);

    const lock: BrowserProfileLock = this.profileLocks.acquire(identity, this.options.ownerId, startedAt);
    let page: BrowserPageSessionPort | undefined;
    let media: LocalMediaArtifact | undefined;
    let closed = false;
    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      if (page) await page.close().catch(() => {});
      if (media && this.mediaMaterializer.release) await this.mediaMaterializer.release(media).catch(() => {});
      lock.release();
    };

    try {
      page = await this.browserRuntime.launch(identity, { headless: this.options.headless ?? true, initialUrl: "about:blank" });
      await new BrowserSessionHealthService(this.store, probe).check(
        identity.identityId,
        page,
        this.now(),
        { type: "worker", id: this.options.ownerId }
      );
      new AccountIdentityGuard(this.store).assertReady(identity.identityId);

      const content = this.store.getContentItem(intent.contentId);
      if (!content) throw new Error(`Content item not found: ${intent.contentId}`);
      if (content.item.creatorId !== intent.creatorId) throw new Error(`Intent/content creator mismatch for ${intent.intentId}`);
      const payload = await this.payloadResolver.resolve(intent);
      media = await this.mediaMaterializer.materialize(content.item);
      if (!/^[a-f0-9]{64}$/i.test(media.sha256)) throw new Error(`Materialized media has invalid SHA-256: ${media.sha256}`);

      const prepared = await adapter.prepare(page, identity, intent, media, payload, this.artifacts, this.now);
      if (!prepared.reachedFinalActionBoundary) throw new Error("Adapter did not reach final action boundary");
      const capabilityProbe = await adapter.probeCapabilities(page, identity, intent, this.now());
      this.store.recordCapabilityProbe(capabilityProbe, { type: "worker", id: this.options.ownerId });
      const missing = adapter.requiredCapabilities(intent).filter((capability: PlatformCapability) => capabilityProbe.capabilities[capability] !== "AVAILABLE");
      if (missing.length > 0) throw new PlatformCapabilityMissingError(`Required capabilities not available for ${intent.intentId}: ${missing.join(", ")}`);

      const attempt: PublishAttempt = {
        attemptId: attemptId(intent.intentId, startedAt),
        intentId: intent.intentId,
        browserIdentityId: identity.identityId,
        releaseSha: this.options.releaseSha,
        startedAt: new Date(startedAt).toISOString(),
        finishedAt: new Date(this.now()).toISOString(),
        result: "prepared",
        mediaSha256: media.sha256,
        preparationArtifactRefs: prepared.artifactRefs,
        reachedFinalActionBoundary: true
      };
      return { attempt, session: page, media, adapter, identityId: identity.identityId, close };
    } catch (error) {
      await close();
      throw error;
    }
  }
}
