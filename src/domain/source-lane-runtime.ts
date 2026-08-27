import type { ContentItem, SourceObservation } from "./model.js";
import type { IngressInterpreterPort } from "./ports.js";
import type { SourceActivationCursor, SourceConnection, SourceLane } from "./distribution.js";

export interface SourceActivationBaseline {
  laneId: string;
  cursorFingerprint: string;
  capturedAt: string;
  externalObjectIds: readonly string[];
}

export interface StoredSourceActivationBaseline {
  baseline: SourceActivationBaseline;
  createdAt: string;
}

export interface SourceActivationBaselineStorePort {
  putBaseline(baseline: SourceActivationBaseline, now: string): { created: boolean; record: StoredSourceActivationBaseline };
  getBaseline(laneId: string, cursorFingerprint: string): StoredSourceActivationBaseline | null;
}

export interface SourceLaneObservationPort {
  observeLane(source: SourceConnection, lane: SourceLane, now: string): Promise<readonly SourceObservation[]>;
}

export interface SourceLaneInterpreterFactoryPort {
  forLane(lane: SourceLane): IngressInterpreterPort;
}

export type MediaReadinessProbeOutcome = "READABLE" | "RETRY" | "BLOCKED";
export interface MediaReadinessProbeResult {
  outcome: MediaReadinessProbeOutcome;
  sha256?: string;
  sizeBytes?: number;
  durationSeconds?: number;
  note?: string;
}

export interface MediaReadinessProbePort {
  probe(content: ContentItem): Promise<MediaReadinessProbeResult>;
}

export interface SourceLaneActivationDecision {
  eligible: boolean;
  reason: "NEW_AFTER_BASELINE" | "BASELINE_EXISTING" | "SINCE" | "BEFORE_SINCE" | "IMPORT_BACKLOG" | "SELECTED" | "NOT_SELECTED" | "MISSING_TIMESTAMP";
}

export interface SourceLaneScanLaneReport {
  laneId: string;
  observed: number;
  eligible: number;
  historicalIgnored: number;
  accepted: number;
  stabilizing: number;
  ready: number;
  blocked: number;
  conflicts: number;
  notes: readonly string[];
}

export interface SourceLaneScanReport {
  startedAt: string;
  finishedAt: string;
  lanes: readonly SourceLaneScanLaneReport[];
  observed: number;
  eligible: number;
  ready: number;
  stabilizing: number;
  blocked: number;
  conflicts: number;
}

export interface SourceActivationContext {
  cursor: SourceActivationCursor;
  baseline: SourceActivationBaseline | null;
}
