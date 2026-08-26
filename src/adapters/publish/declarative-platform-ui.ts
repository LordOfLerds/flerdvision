import type { BrowserIdentity } from "../../domain/browser-identity.js";
import type { BrowserPageSessionPort } from "../../domain/browser-identity-ports.js";
import type { PublicationIntent, PublicationFormat } from "../../domain/model.js";
import type {
  LocalMediaArtifact,
  PlatformCapability,
  PlatformCapabilityProbe,
  PlatformPrepareResult,
  PlatformUiSpec,
  PreparationActionJournalEntry,
  PublicationPayload,
  UiActionSpec,
  UiLocator
} from "../../domain/platform-ui.js";
import type { PlatformUiAdapterPort, PrepareArtifactSinkPort } from "../../domain/platform-ui-ports.js";
import { BrowserDomUiDriver, UiTargetNotFoundError } from "../browser/dom-ui-driver.js";

export class UnsupportedPublicationFormatError extends Error {}
export class PlatformPreparationError extends Error {}

function probeId(accountId: string, now: string): string {
  return `cap:${accountId}:${new Date(now).getTime().toString(36)}:${Math.random().toString(36).slice(2, 9)}`;
}

function payloadValue(action: UiActionSpec, payload: PublicationPayload, media: LocalMediaArtifact): string | undefined {
  if (action.literalValue !== undefined) return action.literalValue;
  if (!action.valueFrom) return undefined;
  if (action.valueFrom === "media") return media.localPath;
  if (action.valueFrom === "caption") return payload.caption;
  if (action.valueFrom === "title") return payload.title;
  if (action.valueFrom === "description") return payload.description;
  if (action.valueFrom === "hashtags") {
    return payload.hashtags?.map((tag) => tag.startsWith("#") ? tag : `#${tag}`).join(" ");
  }
  return undefined;
}

async function present(driver: BrowserDomUiDriver, locators: readonly UiLocator[] | undefined): Promise<"AVAILABLE" | "UNAVAILABLE" | "UNKNOWN"> {
  if (!locators || locators.length === 0) return "UNKNOWN";
  return await driver.isPresent(locators, 300, false) ? "AVAILABLE" : "UNAVAILABLE";
}

export class DeclarativePlatformUiAdapter implements PlatformUiAdapterPort {
  readonly platform: PublicationIntent["platform"];

  constructor(readonly spec: PlatformUiSpec) {
    this.platform = spec.platform;
  }

  finalActionLocators(intent: PublicationIntent): readonly UiLocator[] {
    if (intent.platform !== this.platform) throw new PlatformPreparationError(`Intent platform ${intent.platform} does not match ${this.platform} adapter`);
    return this.spec.finalActionBoundary;
  }

  requiredCapabilities(intent: PublicationIntent): readonly PlatformCapability[] {
    if (intent.platform !== this.platform) throw new PlatformPreparationError(`Intent platform ${intent.platform} does not match ${this.platform} adapter`);
    return this.spec.requiredCapabilities[intent.format] ?? [];
  }

  async probeCapabilities(
    session: BrowserPageSessionPort,
    identity: BrowserIdentity,
    intent: PublicationIntent,
    now: string
  ): Promise<PlatformCapabilityProbe> {
    if (identity.platform !== this.platform || intent.platform !== this.platform || identity.accountId !== intent.accountId) {
      throw new PlatformPreparationError("Capability probe platform/account mismatch");
    }
    const driver = new BrowserDomUiDriver(session);
    const capabilities: Partial<Record<PlatformCapability, "AVAILABLE" | "UNAVAILABLE" | "UNKNOWN">> = {};
    const known: PlatformCapability[] = [
      "web_video_upload", "caption", "title", "description", "reel", "trial_reel",
      "tiktok_video", "youtube_short", "story", "final_action_boundary"
    ];
    for (const capability of known) {
      const locators = capability === "final_action_boundary"
        ? this.spec.finalActionBoundary
        : this.spec.capabilityLocators[capability];
      capabilities[capability] = await present(driver, locators);
    }
    return {
      probeId: probeId(intent.accountId, now),
      accountId: intent.accountId,
      identityId: identity.identityId,
      platform: intent.platform,
      probedAt: new Date(now).toISOString(),
      capabilities,
      currentUrl: await session.currentUrl()
    };
  }

  async prepare(
    session: BrowserPageSessionPort,
    identity: BrowserIdentity,
    intent: PublicationIntent,
    media: LocalMediaArtifact,
    payload: PublicationPayload,
    artifacts: PrepareArtifactSinkPort,
    now: () => string
  ): Promise<PlatformPrepareResult> {
    if (intent.platform !== this.platform || identity.platform !== this.platform || identity.accountId !== intent.accountId) {
      throw new PlatformPreparationError("Prepare platform/account mismatch");
    }
    if (!this.spec.supportedFormats.includes(intent.format)) {
      throw new UnsupportedPublicationFormatError(`${this.platform} adapter does not support ${intent.format}`);
    }
    if (payload.copyVersionId !== intent.copyVersionId) {
      throw new PlatformPreparationError(`Payload version ${payload.copyVersionId} does not match intent ${intent.copyVersionId}`);
    }

    const driver = new BrowserDomUiDriver(session);
    const journal: PreparationActionJournalEntry[] = [];
    const artifactRefs: string[] = [];
    const record = (entry: PreparationActionJournalEntry): void => { journal.push(entry); };
    const executeActions = async (actions: readonly UiActionSpec[]): Promise<void> => {
      for (const action of actions) {
        const at = now();
        const value = payloadValue(action, payload, media);
        if (action.valueFrom && value === undefined) {
          if (action.optional) {
            record({ at, label: action.label, action: action.action, outcome: "optional_missing", note: `No value for ${action.valueFrom}` });
            continue;
          }
          throw new PlatformPreparationError(`Required payload value missing for ${action.label}: ${action.valueFrom}`);
        }
        try {
          const locator = await driver.execute(action, value, this.spec.finalActionBoundary);
          record({ at, label: action.label, action: action.action, outcome: "ok", ...(locator ? { locator } : {}) });
        } catch (error) {
          if (action.optional && error instanceof UiTargetNotFoundError) {
            record({ at, label: action.label, action: action.action, outcome: "optional_missing", note: error.message });
            continue;
          }
          record({ at, label: action.label, action: action.action, outcome: "blocked", note: error instanceof Error ? error.message : String(error) });
          throw error;
        }
      }
    };

    await session.navigate(this.spec.bootstrapUrl);
    artifactRefs.push(...await artifacts.captureBoundary(session, intent, identity, "01-bootstrap", now()));
    await executeActions(this.spec.preUploadActions);
    await executeActions(this.spec.uploadActions);
    artifactRefs.push(...await artifacts.captureBoundary(session, intent, identity, "02-media-loaded", now()));
    await executeActions(this.spec.fieldActions);
    await executeActions(this.spec.formatActions[intent.format] ?? []);
    artifactRefs.push(...await artifacts.captureBoundary(session, intent, identity, "03-fields-and-format", now()));

    let boundaryLocator: string;
    try {
      boundaryLocator = (await driver.locate(this.spec.finalActionBoundary, 10_000, true)).descriptor;
    } catch (error) {
      record({
        at: now(), label: "final-action-boundary", action: "assert_visible", outcome: "blocked",
        note: error instanceof Error ? error.message : String(error)
      });
      throw new PlatformPreparationError("Final action boundary was not reachable; no irreversible action was invoked");
    }
    record({ at: now(), label: "final-action-boundary", action: "assert_visible", outcome: "ok", locator: boundaryLocator });
    artifactRefs.push(...await artifacts.captureBoundary(session, intent, identity, "99-final-action-boundary", now()));
    const journalRef = await artifacts.writeJournal(intent, journal, now());
    artifactRefs.push(journalRef);

    return {
      intentId: intent.intentId,
      accountId: intent.accountId,
      identityId: identity.identityId,
      platform: intent.platform,
      format: intent.format,
      mediaSha256: media.sha256,
      mediaSizeBytes: media.sizeBytes,
      reachedFinalActionBoundary: true,
      artifactRefs,
      journal,
      preparedAt: new Date(now()).toISOString()
    };
  }
}

function assertPlatform(spec: PlatformUiSpec, expected: PlatformUiSpec["platform"]): void {
  if (spec.platform !== expected) throw new Error(`Expected ${expected} UI spec, got ${spec.platform}`);
}

export class InstagramWebPrepareAdapter extends DeclarativePlatformUiAdapter {
  constructor(spec: PlatformUiSpec) { assertPlatform(spec, "instagram"); super(spec); }
}

export class TikTokWebPrepareAdapter extends DeclarativePlatformUiAdapter {
  constructor(spec: PlatformUiSpec) { assertPlatform(spec, "tiktok"); super(spec); }
}

export class YouTubeStudioPrepareAdapter extends DeclarativePlatformUiAdapter {
  constructor(spec: PlatformUiSpec) { assertPlatform(spec, "youtube"); super(spec); }
}

export function formatCapabilityRequirements(spec: PlatformUiSpec, format: PublicationFormat): readonly PlatformCapability[] {
  return spec.requiredCapabilities[format] ?? [];
}
