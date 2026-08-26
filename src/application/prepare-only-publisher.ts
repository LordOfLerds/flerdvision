import type { BrowserIdentityStorePort, BrowserProfileLockPort, BrowserRuntimePort, SessionProbePort } from "../domain/browser-identity-ports.js";
import { AccountIdentityGuard, BrowserSessionHealthService } from "./browser-identity-service.js";
import type { IngressStorePort } from "../domain/ingress-ports.js";
import type { PublicationIntent, PublishAttempt } from "../domain/model.js";
import type { PublisherPort, PublishContext } from "../domain/ports.js";
import type { PlatformCapabilityStorePort, MediaMaterializerPort, PlatformUiAdapterPort, PrepareArtifactSinkPort, PublicationPayloadResolverPort } from "../domain/platform-ui-ports.js";
import type { PlatformCapability } from "../domain/platform-ui.js";

export class PrepareOnlyFinalActionError extends Error {}
export class PlatformCapabilityMissingError extends Error {}
export class PlatformAdapterMissingError extends Error {}

export interface PrepareOnlyPublisherOptions {
  releaseSha: string;
  ownerId: string;
  headless?: boolean;
  now?: () => string;
}

type PrepareStore = BrowserIdentityStorePort & IngressStorePort & PlatformCapabilityStorePort;

function attemptId(intentId: string, now: string): string {
  return `attempt:${intentId}:${new Date(now).getTime().toString(36)}:${Math.random().toString(36).slice(2, 9)}`;
}

export class PrepareOnlyPlatformPublisher implements PublisherPort {
  private readonly adapters = new Map<PublicationIntent["platform"], PlatformUiAdapterPort>();
  private readonly now: () => string;

  constructor(
    private readonly store: PrepareStore,
    private readonly browserRuntime: BrowserRuntimePort,
    private readonly profileLocks: BrowserProfileLockPort,
    private readonly sessionProbes: Readonly<Record<PublicationIntent["platform"], SessionProbePort>>,
    private readonly payloadResolver: PublicationPayloadResolverPort,
    private readonly mediaMaterializer: MediaMaterializerPort,
    private readonly artifacts: PrepareArtifactSinkPort,
    platformAdapters: readonly PlatformUiAdapterPort[],
    private readonly options: PrepareOnlyPublisherOptions
  ) {
    for (const adapter of platformAdapters) {
      if (this.adapters.has(adapter.platform)) throw new Error(`Duplicate platform adapter: ${adapter.platform}`);
      this.adapters.set(adapter.platform, adapter);
    }
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async prepare(intent: PublicationIntent): Promise<PublishAttempt> {
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

    const lock = this.profileLocks.acquire(identity, this.options.ownerId, startedAt);
    let page: Awaited<ReturnType<BrowserRuntimePort["launch"]>> | undefined;
    let media: Awaited<ReturnType<MediaMaterializerPort["materialize"]>> | undefined;
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
      if (missing.length > 0) {
        throw new PlatformCapabilityMissingError(`Required capabilities not available for ${intent.intentId}: ${missing.join(", ")}`);
      }

      return {
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
    } finally {
      if (page) await page.close().catch(() => {});
      if (media && this.mediaMaterializer.release) await this.mediaMaterializer.release(media).catch(() => {});
      lock.release();
    }
  }

  async invokeFinalAction(
    _intent: PublicationIntent,
    _preparedAttempt: PublishAttempt,
    _context: PublishContext
  ): Promise<PublishAttempt> {
    throw new PrepareOnlyFinalActionError("W4 publisher contains no final-action implementation. Final publish is physically unavailable.");
  }
}
