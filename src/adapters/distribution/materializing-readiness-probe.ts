import type { MediaInspectorPort } from "../../domain/media-inspection-ports.js";
import type { MediaMaterializerPort } from "../../domain/platform-ui-ports.js";
import type { ContentItem } from "../../domain/model.js";
import type { MediaReadinessProbePort, MediaReadinessProbeResult } from "../../domain/source-lane-runtime.js";

/**
 * READY means the exact source reference can be materialized AND inspected as a positive-duration
 * video. Provider/network/inspector execution failures remain RETRY; structurally invalid media is
 * BLOCKED. Local SHA-256 is readiness evidence and never replaces provider source identity.
 */
export class MaterializingMediaReadinessProbe implements MediaReadinessProbePort {
  constructor(private readonly materializer: MediaMaterializerPort,private readonly inspector:MediaInspectorPort) {}

  async probe(content: ContentItem): Promise<MediaReadinessProbeResult> {
    try {
      const artifact = await this.materializer.materialize(content);
      try {
        if (artifact.sizeBytes <= 0) return { outcome: "BLOCKED", note: "materialized_media_is_empty" };
        const inspection=await this.inspector.inspect(artifact.localPath);
        if(!inspection.validVideo){
          return{outcome:"BLOCKED",sha256:artifact.sha256,sizeBytes:artifact.sizeBytes,...(inspection.durationSeconds!==undefined?{durationSeconds:inspection.durationSeconds}:{}),note:inspection.note??"media_is_not_a_positive_duration_video"};
        }
        return{
          outcome:"READABLE",
          sha256:artifact.sha256,
          sizeBytes:artifact.sizeBytes,
          ...(inspection.durationSeconds!==undefined?{durationSeconds:inspection.durationSeconds}:{})
        };
      } finally {
        await this.materializer.release?.(artifact).catch(()=>{});
      }
    } catch (error) {
      return { outcome: "RETRY", note: error instanceof Error ? error.message : String(error) };
    }
  }
}
