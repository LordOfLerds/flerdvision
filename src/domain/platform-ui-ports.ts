import type { Actor } from "./control-plane.js";
import type { BrowserIdentity } from "./browser-identity.js";
import type { BrowserPageSessionPort } from "./browser-identity-ports.js";
import type { ContentItem, Instant, PublicationIntent } from "./model.js";
import type {
  LocalMediaArtifact,
  PlatformCapabilityProbe,
  PlatformPrepareResult,
  PublicationPayload
} from "./platform-ui.js";

export interface PlatformCapabilityStorePort {
  recordCapabilityProbe(probe: PlatformCapabilityProbe, actor: Actor): PlatformCapabilityProbe;
  latestCapabilityProbe(accountId: string): PlatformCapabilityProbe | null;
  listCapabilityProbes(accountId?: string): readonly PlatformCapabilityProbe[];
}

export interface PublicationPayloadResolverPort {
  resolve(intent: PublicationIntent): Promise<PublicationPayload>;
}

export interface MediaMaterializerPort {
  materialize(content: ContentItem): Promise<LocalMediaArtifact>;
  release?(artifact: LocalMediaArtifact): Promise<void>;
}

export interface PrepareArtifactSinkPort {
  captureBoundary(
    session: BrowserPageSessionPort,
    intent: PublicationIntent,
    identity: BrowserIdentity,
    label: string,
    now: Instant
  ): Promise<readonly string[]>;
  writeJournal(intent: PublicationIntent, entries: readonly unknown[], now: Instant): Promise<string>;
}

export interface PlatformUiAdapterPort {
  readonly platform: PublicationIntent["platform"];
  requiredCapabilities(intent: PublicationIntent): readonly import("./platform-ui.js").PlatformCapability[];
  probeCapabilities(
    session: BrowserPageSessionPort,
    identity: BrowserIdentity,
    intent: PublicationIntent,
    now: Instant
  ): Promise<PlatformCapabilityProbe>;
  prepare(
    session: BrowserPageSessionPort,
    identity: BrowserIdentity,
    intent: PublicationIntent,
    media: LocalMediaArtifact,
    payload: PublicationPayload,
    artifacts: PrepareArtifactSinkPort,
    now: () => Instant
  ): Promise<PlatformPrepareResult>;
}
