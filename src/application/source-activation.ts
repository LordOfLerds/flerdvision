import { createHash } from "node:crypto";
import type { SourceObservation } from "../domain/model.js";
import type { SourceActivationCursor, SourceConnection, SourceLane } from "../domain/distribution.js";
import type {
  SourceActivationBaseline,
  SourceActivationBaselineStorePort,
  SourceLaneActivationDecision,
  SourceLaneObservationPort
} from "../domain/source-lane-runtime.js";

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sourceActivationCursorFingerprint(cursor: SourceActivationCursor): string {
  return createHash("sha256").update(stable(cursor)).digest("hex");
}

export function sourceActivationObservationSnapshotFingerprint(observations: readonly SourceObservation[]): string {
  const ids=[...new Set(observations.map(item=>item.externalObjectId))].sort();
  return createHash("sha256").update(JSON.stringify(ids)).digest("hex");
}

function observationTimestamp(observation: SourceObservation): string | undefined {
  return observation.metadata.createdTime ?? observation.metadata.modifiedTime ?? observation.metadata.sourceModifiedAt;
}

export function activationDecision(
  cursor: SourceActivationCursor,
  baseline: SourceActivationBaseline | null,
  observation: SourceObservation
): SourceLaneActivationDecision {
  if (cursor.mode === "IMPORT_BACKLOG") return { eligible: true, reason: "IMPORT_BACKLOG" };
  if (cursor.mode === "SELECTED") {
    const selected = new Set(cursor.selectedExternalObjectIds ?? []);
    return selected.has(observation.externalObjectId)
      ? { eligible: true, reason: "SELECTED" }
      : { eligible: false, reason: "NOT_SELECTED" };
  }
  if (cursor.mode === "SINCE") {
    const since = cursor.since;
    if (!since) return { eligible: false, reason: "MISSING_TIMESTAMP" };
    const observed = observationTimestamp(observation);
    if (!observed) return { eligible: false, reason: "MISSING_TIMESTAMP" };
    return new Date(observed).getTime() >= new Date(since).getTime()
      ? { eligible: true, reason: "SINCE" }
      : { eligible: false, reason: "BEFORE_SINCE" };
  }
  if (!baseline || baseline.cursorFingerprint !== sourceActivationCursorFingerprint(cursor)) {
    return { eligible: false, reason: "BASELINE_EXISTING" };
  }
  const existing = new Set(baseline.externalObjectIds);
  return existing.has(observation.externalObjectId)
    ? { eligible: false, reason: "BASELINE_EXISTING" }
    : { eligible: true, reason: "NEW_AFTER_BASELINE" };
}

export class SourceActivationService {
  constructor(
    private readonly observations: SourceLaneObservationPort,
    private readonly baselines: SourceActivationBaselineStorePort
  ) {}

  async ensureBaseline(
    source: SourceConnection,
    lane: SourceLane,
    cursor: SourceActivationCursor,
    now: string,
    expectedSnapshotFingerprint?: string
  ): Promise<SourceActivationBaseline | null> {
    if (cursor.mode !== "NEW_ONLY") return null;
    const cursorFingerprint = sourceActivationCursorFingerprint(cursor);
    const existing = this.baselines.getBaseline(lane.laneId, cursorFingerprint);
    if (existing) return existing.baseline;

    const observed = await this.observations.observeLane(source, lane, now);
    const snapshotFingerprint=sourceActivationObservationSnapshotFingerprint(observed);
    if(expectedSnapshotFingerprint&&snapshotFingerprint!==expectedSnapshotFingerprint){
      throw new Error(`Source lane ${lane.laneId} changed after baseline preview; preview again before capture`);
    }
    const baseline: SourceActivationBaseline = {
      laneId: lane.laneId,
      cursorFingerprint,
      capturedAt: new Date(now).toISOString(),
      externalObjectIds: [...new Set(observed.map((item) => item.externalObjectId))].sort()
    };
    return this.baselines.putBaseline(baseline, now).record.baseline;
  }
}
