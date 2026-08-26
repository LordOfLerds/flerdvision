import type { PublicationIntent } from "../../domain/model.js";
import type { PublicationPayload } from "../../domain/platform-ui.js";
import type { PublicationPayloadResolverPort } from "../../domain/platform-ui-ports.js";

export class PublicationPayloadNotFoundError extends Error {}

export class StaticPublicationPayloadResolver implements PublicationPayloadResolverPort {
  private readonly byVersion: ReadonlyMap<string, PublicationPayload>;

  constructor(payloads: readonly PublicationPayload[]) {
    const map = new Map<string, PublicationPayload>();
    for (const payload of payloads) {
      if (!payload.copyVersionId.trim()) throw new Error("copyVersionId cannot be empty");
      if (map.has(payload.copyVersionId)) throw new Error(`Duplicate copyVersionId: ${payload.copyVersionId}`);
      map.set(payload.copyVersionId, payload);
    }
    this.byVersion = map;
  }

  async resolve(intent: PublicationIntent): Promise<PublicationPayload> {
    const payload = this.byVersion.get(intent.copyVersionId);
    if (!payload) throw new PublicationPayloadNotFoundError(`No payload configured for ${intent.copyVersionId}`);
    return payload;
  }
}
