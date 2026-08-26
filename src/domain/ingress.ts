import type { ContentItem, Instant, SourceObservation, UUID } from "./model.js";

export type SourceObservationState = "OBSERVED" | "ACCEPTED" | "IGNORED" | "BLOCKED";
export type SourceDispositionState = "COMPLETED" | "BLOCKED";

export interface StoredSourceObservation {
  observation: SourceObservation;
  state: SourceObservationState;
  firstObservedAt: Instant;
  lastObservedAt: Instant;
  seenCount: number;
  contentId?: UUID;
  reason?: string;
}

export interface StoredContentItem {
  item: ContentItem;
  createdAt: Instant;
}

export interface SourceDispositionRecord {
  sourceObservationId: UUID;
  state: SourceDispositionState;
  publicationIds: readonly UUID[];
  reason?: string;
  updatedAt: Instant;
}

export type ObserveSourceResult =
  | { status: "created"; record: StoredSourceObservation }
  | { status: "duplicate"; record: StoredSourceObservation }
  | { status: "conflict"; record: StoredSourceObservation; reason: string };

export type CreateContentResult =
  | { created: true; record: StoredContentItem }
  | { created: false; record: StoredContentItem };

export interface IngressRunReport {
  observed: number;
  createdObservations: number;
  duplicateObservations: number;
  accepted: number;
  ignored: number;
  blocked: number;
  conflicts: number;
  createdContentItems: number;
  existingContentItems: number;
}
