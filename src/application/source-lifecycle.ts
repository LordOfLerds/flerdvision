import type { SourceObservation } from "../domain/model.js";
import {
  type AssetReadinessEvidence,
  type ContentAsset,
  type SourceActivationCursor,
  isAssetReady
} from "../domain/distribution.js";

export type SourceActivationDecision = "ACCEPT" | "HISTORICAL" | "NOT_SELECTED";

export function activationDecision(cursor: SourceActivationCursor, observation: SourceObservation): SourceActivationDecision {
  if (cursor.mode === "IMPORT_BACKLOG") return "ACCEPT";
  if (cursor.mode === "SELECTED") {
    return cursor.selectedExternalObjectIds?.includes(observation.externalObjectId) ? "ACCEPT" : "NOT_SELECTED";
  }
  const observedAt = new Date(observation.observedAt).getTime();
  if (!Number.isFinite(observedAt)) throw new Error(`Invalid observation time: ${observation.observedAt}`);
  const threshold = new Date(cursor.mode === "SINCE" ? (cursor.since ?? cursor.activatedAt) : cursor.activatedAt).getTime();
  if (!Number.isFinite(threshold)) throw new Error(`Invalid activation cursor time for lane ${cursor.laneId}`);
  return observedAt >= threshold ? "ACCEPT" : "HISTORICAL";
}

export interface AssetReadinessTransition {
  asset: ContentAsset;
  changed: boolean;
  reason: "ready" | "still_syncing" | "media_unreadable" | "already_terminal";
}

/**
 * Fail closed around cloud-sync races. A stable readable file can become READY; unstable bytes stay
 * STABILIZING; stable-but-unreadable media is BLOCKED instead of being handed to the planner.
 */
export function applyAssetReadinessEvidence(
  asset: ContentAsset,
  evidence: AssetReadinessEvidence,
  now: string
): AssetReadinessTransition {
  if (asset.state === "COMPLETE" || asset.state === "BLOCKED") {
    return { asset, changed: false, reason: "already_terminal" };
  }
  if (asset.assetId !== evidence.assetId) throw new Error(`Readiness evidence ${evidence.assetId} does not belong to asset ${asset.assetId}`);
  if (isAssetReady(asset, evidence)) {
    return { asset: { ...asset, state: "READY", readyAt: new Date(now).toISOString() }, changed: asset.state !== "READY", reason: "ready" };
  }
  if (evidence.stableFingerprint && evidence.stableSize && !evidence.mediaReadable) {
    return { asset: { ...asset, state: "BLOCKED" }, changed: true, reason: "media_unreadable" };
  }
  const { readyAt: _readyAt, ...withoutReadyAt } = asset;
  return { asset: { ...withoutReadyAt, state: "STABILIZING" }, changed: asset.state !== "STABILIZING", reason: "still_syncing" };
}
