import type { MediaMaterializerPort } from "../../domain/platform-ui-ports.js";
import type { ContentItem } from "../../domain/model.js";
import type { MediaReadinessProbePort, MediaReadinessProbeResult } from "../../domain/source-lane-runtime.js";

/**
 * Uses the same materializer as the publishing path, so READY means the exact source reference can
 * actually become a local upload artifact. Network/provider failures remain RETRY; zero-byte media
 * is a hard block. The local SHA-256 becomes durable readiness evidence but never replaces the
 * provider fingerprint used for source-mutation identity.
 */
export class MaterializingMediaReadinessProbe implements MediaReadinessProbePort {
  constructor(private readonly materializer: MediaMaterializerPort) {}

  async probe(content: ContentItem): Promise<MediaReadinessProbeResult> {
    try {
      const artifact = await this.materializer.materialize(content);
      try {
        if (artifact.sizeBytes <= 0) return { outcome: "BLOCKED", note: "materialized_media_is_empty" };
        return { outcome: "READABLE", sha256: artifact.sha256, sizeBytes: artifact.sizeBytes };
      } finally {
        await this.materializer.release?.(artifact);
      }
    } catch (error) {
      return { outcome: "RETRY", note: error instanceof Error ? error.message : String(error) };
    }
  }
}
