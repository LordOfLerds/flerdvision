import type { BrowserIdentityStorePort, BrowserProfileLockPort, BrowserRuntimePort, SessionProbePort } from "../domain/browser-identity-ports.js";
import type { IngressStorePort } from "../domain/ingress-ports.js";
import type { PublicationIntent, PublishAttempt } from "../domain/model.js";
import type { PublisherPort, PublishContext } from "../domain/ports.js";
import type { PlatformCapabilityStorePort, MediaMaterializerPort, PlatformUiAdapterPort, PrepareArtifactSinkPort, PublicationPayloadResolverPort } from "../domain/platform-ui-ports.js";
import { PlatformPreparationCoordinator, PlatformAdapterMissingError, PlatformCapabilityMissingError, type PlatformPreparationOptions } from "./platform-preparation.js";

export class PrepareOnlyFinalActionError extends Error {}
export { PlatformAdapterMissingError, PlatformCapabilityMissingError };

export interface PrepareOnlyPublisherOptions extends PlatformPreparationOptions {}

type PrepareStore = BrowserIdentityStorePort & IngressStorePort & PlatformCapabilityStorePort;

export class PrepareOnlyPlatformPublisher implements PublisherPort {
  private readonly coordinator: PlatformPreparationCoordinator;

  constructor(
    store: PrepareStore,
    browserRuntime: BrowserRuntimePort,
    profileLocks: BrowserProfileLockPort,
    sessionProbes: Readonly<Record<PublicationIntent["platform"], SessionProbePort>>,
    payloadResolver: PublicationPayloadResolverPort,
    mediaMaterializer: MediaMaterializerPort,
    artifacts: PrepareArtifactSinkPort,
    platformAdapters: readonly PlatformUiAdapterPort[],
    options: PrepareOnlyPublisherOptions
  ) {
    this.coordinator = new PlatformPreparationCoordinator(store, browserRuntime, profileLocks, sessionProbes, payloadResolver, mediaMaterializer, artifacts, platformAdapters, options);
  }

  async prepare(intent: PublicationIntent): Promise<PublishAttempt> {
    const prepared = await this.coordinator.open(intent);
    try {
      return prepared.attempt;
    } finally {
      await prepared.close();
    }
  }

  async invokeFinalAction(_intent: PublicationIntent, _preparedAttempt: PublishAttempt, _context: PublishContext): Promise<PublishAttempt> {
    throw new PrepareOnlyFinalActionError("W4 publisher contains no final-action implementation. Final publish is physically unavailable.");
  }
}
