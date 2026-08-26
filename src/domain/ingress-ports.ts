import type { ContentItem, Instant, SourceObservation } from "./model.js";
import type { Actor } from "./control-plane.js";
import type {
  CreateContentResult,
  ObserveSourceResult,
  SourceDispositionRecord,
  SourceObservationState,
  StoredContentItem,
  StoredSourceObservation
} from "./ingress.js";

export interface IngressStorePort {
  observeOrGetSource(observation: SourceObservation, now: Instant, actor: Actor): ObserveSourceResult;
  getSourceObservation(observationId: string): StoredSourceObservation | null;
  listSourceObservations(states?: readonly SourceObservationState[]): readonly StoredSourceObservation[];
  decideSourceObservation(
    observationId: string,
    decision: Exclude<SourceObservationState, "OBSERVED">,
    now: Instant,
    actor: Actor,
    options?: { contentId?: string; reason?: string }
  ): StoredSourceObservation;
  createOrGetContent(item: ContentItem, now: Instant, actor: Actor): CreateContentResult;
  getContentItem(contentId: string): StoredContentItem | null;
  listContentItems(): readonly StoredContentItem[];
  getSourceDisposition(observationId: string): SourceDispositionRecord | null;
  recordSourceDisposition(record: SourceDispositionRecord, actor: Actor): SourceDispositionRecord;
}

export interface SourceObservationLookupPort {
  getSourceObservation(observationId: string): StoredSourceObservation | null;
}
