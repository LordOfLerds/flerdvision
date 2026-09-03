import type { DistributionRuntimeStateStorePort } from "../../domain/distribution-runtime-ports.js";
import type { PublicationIntent } from "../../domain/model.js";
import { composePostedCaption } from "../../domain/platform-ui.js";
import type { PublicationPayloadResolverPort } from "../../domain/platform-ui-ports.js";
import type { ExpectedPublicationCopyPort, ExpectedPublishedCopy } from "../../domain/verification-ports.js";

/**
 * Reconstructs what the run posted from the same payload resolver the publisher posted with, so
 * marker-free verification compares against the run's own copy and never against something read
 * off the platform. The media duration is a second, optional signal: it only ever disambiguates
 * two posts that already carry the same caption.
 */
export class PayloadExpectedPublicationCopy implements ExpectedPublicationCopyPort {
  constructor(
    private readonly payloads: PublicationPayloadResolverPort,
    private readonly runtimeState?: DistributionRuntimeStateStorePort
  ) {}

  async expected(intent: PublicationIntent): Promise<ExpectedPublishedCopy> {
    const payload = await this.payloads.resolve(intent);
    const caption = composePostedCaption(payload);
    const durationSeconds = this.durationFor(intent.contentId);
    return {
      ...(caption !== undefined ? { caption } : {}),
      ...(payload.title !== undefined ? { title: payload.title } : {}),
      ...(durationSeconds !== undefined ? { mediaDurationSeconds: durationSeconds } : {})
    };
  }

  /** ffprobe wrote this during the source readiness check; absence is normal, never an error. */
  private durationFor(contentId: string): number | undefined {
    if (!this.runtimeState) return undefined;
    const asset = this.runtimeState.listAssets().find((record) => record.asset.contentId === contentId);
    const raw = asset?.asset.metadata.readinessDurationSeconds;
    if (!raw) return undefined;
    const seconds = Number(raw);
    return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
  }
}
