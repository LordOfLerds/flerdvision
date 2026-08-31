/**
 * Original-audio integrity.
 *
 * Operator rule: an automatically published video must go out with ITS OWN audio. No recommended
 * track, no library sound, nothing the platform attached on the account's behalf. TikTok's web
 * composer is the concrete risk -- it owns a MusicPanel entrance next to the preview and has
 * historically pre-attached suggestions -- and Instagram offers music suggestions in its editor.
 *
 * This module is deliberately PURE and read-only. It decides; it never repairs. Removing an
 * attached sound would mean clicking through an editor this project has never observed, which is
 * exactly the "free-form click on a production surface" AGENTS.md forbids. A detected sound is a
 * hard stop for a human, not an automation task.
 */

export type AudioIntegrityVerdict =
  /** The compose surface names the video's own audio and nothing else. */
  | "ORIGINAL_AUDIO_ONLY"
  /** The compose surface names a sound that is not the video's own audio. */
  | "ADDED_SOUND_DETECTED"
  /** A calibrated detector ran and could not read a state it is calibrated to always find. */
  | "STATE_UNREADABLE"
  /** No detector is calibrated for this platform; nothing was checked and nothing is claimed. */
  | "NO_CALIBRATED_DETECTOR";

/** Sentinel detector id for a platform this project has no live-calibrated audio detector for. */
export const NO_AUDIO_DETECTOR = "none" as const;

/**
 * A single read-only readout of a live compose surface. Everything here is observation; no field
 * carries a judgement, so the same record can be written to evidence and re-assessed later.
 */
export interface AudioIntegrityObservation {
  platform: string;
  /** Identifies WHICH calibration produced this readout, so drift is attributable. */
  detectorId: string;
  observedAt: string;
  /** Every distinct sound label the compose surface showed. Marquee duplicates are collapsed. */
  attachedSoundLabels: readonly string[];
  /**
   * Sound-related controls the surface offers (e.g. TikTok's "sounds" editor entrance). Purely
   * informational: an ENTRANCE to a music panel is not a selected sound, and treating it as one
   * would block every TikTok run forever.
   */
  soundControls: readonly string[];
  /** Set when the probe itself failed (page gone, evaluate rejected). Fail-closed, not fail-quiet. */
  probeError?: string;
}

export interface AudioIntegrityAssessment {
  verdict: AudioIntegrityVerdict;
  platform: string;
  detectorId: string;
  observedLabel: string | null;
  reason: string;
}

/**
 * Labels a platform uses for "this video's own audio".
 *
 * Live evidence (TikTok web composer, 2026-08-31, 34 qualification snapshots on the de-DE UI):
 * the preview card's `.sound-container` always read exactly `Original-Sound - luca e`. The English
 * form is included because the same account can be served an en-US UI; NO OTHER LOCALE IS
 * VERIFIED. An unrecognised label therefore reads as ADDED_SOUND_DETECTED -- a false hard stop on
 * an unseen locale, never a false pass on a real added track.
 */
export const ORIGINAL_AUDIO_LABEL_PATTERN = /^(?:original[\s-]?sound|originalton|original[\s-]?audio)\s*[-–—]\s*\S/u;

function normalizeLabel(value: string): string {
  return value.replace(/\s+/gu, " ").trim().toLocaleLowerCase("en-US");
}

/** True when the label names the video's own audio rather than an attached track. */
export function isOriginalAudioLabel(label: string): boolean {
  return ORIGINAL_AUDIO_LABEL_PATTERN.test(normalizeLabel(label));
}

/** Collapses the marquee duplication real surfaces use for scrolling text. */
function distinctLabels(labels: readonly string[]): readonly string[] {
  const seen = new Map<string, string>();
  for (const raw of labels) {
    const label = raw.replace(/\s+/gu, " ").trim();
    if (label.length === 0) continue;
    if (!seen.has(normalizeLabel(label))) seen.set(normalizeLabel(label), label);
  }
  return [...seen.values()];
}

export function assessAudioIntegrity(observation: AudioIntegrityObservation): AudioIntegrityAssessment {
  const base = { platform: observation.platform, detectorId: observation.detectorId };
  if (observation.detectorId === NO_AUDIO_DETECTOR) {
    return { ...base, verdict: "NO_CALIBRATED_DETECTOR", observedLabel: null, reason: `No calibrated audio detector exists for ${observation.platform}; the attached sound was not inspected` };
  }
  if (observation.probeError !== undefined) {
    return { ...base, verdict: "STATE_UNREADABLE", observedLabel: null, reason: `Audio probe failed on ${observation.platform}: ${observation.probeError}` };
  }
  const labels = distinctLabels(observation.attachedSoundLabels);
  if (labels.length === 0) {
    // The calibrated surface ALWAYS names its sound; finding nothing means the surface drifted,
    // not that no sound is attached. Silence is not evidence of original audio.
    return { ...base, verdict: "STATE_UNREADABLE", observedLabel: null, reason: `Detector ${observation.detectorId} found no sound label on the ${observation.platform} compose surface; it is calibrated to always find exactly one` };
  }
  if (labels.length > 1) {
    return { ...base, verdict: "STATE_UNREADABLE", observedLabel: labels[0] ?? null, reason: `Detector ${observation.detectorId} found ${labels.length} competing sound labels (${labels.join(" | ")}); the attached sound is ambiguous` };
  }
  const label = labels[0]!;
  if (isOriginalAudioLabel(label)) {
    return { ...base, verdict: "ORIGINAL_AUDIO_ONLY", observedLabel: label, reason: `Compose surface shows the video's own audio (${label})` };
  }
  return { ...base, verdict: "ADDED_SOUND_DETECTED", observedLabel: label, reason: `Compose surface has a sound attached that is not the video's own audio: ${label}` };
}

/**
 * How far the gate enforces.
 *
 * CALIBRATED_PLATFORMS is the honest default: enforce wherever a detector was actually calibrated
 * against live evidence, and record an explicit calibration gap everywhere else. ALL_PLATFORMS
 * additionally refuses to publish on any platform whose audio state this project cannot read at
 * all -- the strictest reading of the operator rule, and a deliberate opt-in because it stops
 * platforms that have never been observed to attach a sound.
 */
export type AudioIntegrityStrictness = "CALIBRATED_PLATFORMS" | "ALL_PLATFORMS";

export interface AudioIntegrityPolicy {
  /** Operator rule "post with original audio only". Off means the surface is not inspected. */
  requireOriginalAudio: boolean;
  strictness: AudioIntegrityStrictness;
}

export const DEFAULT_AUDIO_INTEGRITY_POLICY: AudioIntegrityPolicy = { requireOriginalAudio: true, strictness: "CALIBRATED_PLATFORMS" };

export type AudioIntegrityDecisionCode =
  | "CHECK_DISABLED"
  | "ORIGINAL_AUDIO_CONFIRMED"
  | "ADDED_SOUND_BLOCKED"
  | "AUDIO_STATE_UNREADABLE_BLOCKED"
  | "CALIBRATION_GAP_BLOCKED"
  | "CALIBRATION_GAP_RECORDED";

export interface AudioIntegrityDecision {
  blocked: boolean;
  code: AudioIntegrityDecisionCode;
  message: string;
  assessment: AudioIntegrityAssessment;
}

export function audioIntegrityGateDecision(assessment: AudioIntegrityAssessment, policy: AudioIntegrityPolicy = DEFAULT_AUDIO_INTEGRITY_POLICY): AudioIntegrityDecision {
  if (!policy.requireOriginalAudio) {
    return { blocked: false, code: "CHECK_DISABLED", message: "Original-audio integrity check is disabled by policy", assessment };
  }
  if (assessment.verdict === "ORIGINAL_AUDIO_ONLY") {
    return { blocked: false, code: "ORIGINAL_AUDIO_CONFIRMED", message: assessment.reason, assessment };
  }
  if (assessment.verdict === "ADDED_SOUND_DETECTED") {
    // No automatic removal, by design: the operator removes it, or the run stays stopped.
    return { blocked: true, code: "ADDED_SOUND_BLOCKED", message: `Refusing to continue towards the final action: ${assessment.reason}. Remove the sound in the platform UI so the video posts with its original audio, then re-run. This project never removes a sound on its own.`, assessment };
  }
  if (assessment.verdict === "STATE_UNREADABLE") {
    return { blocked: true, code: "AUDIO_STATE_UNREADABLE_BLOCKED", message: `Refusing to continue towards the final action: ${assessment.reason}. The surface drifted from its calibration; re-calibrate the audio detector against a fresh snapshot before publishing.`, assessment };
  }
  if (policy.strictness === "ALL_PLATFORMS") {
    return { blocked: true, code: "CALIBRATION_GAP_BLOCKED", message: `Refusing to continue towards the final action: ${assessment.reason}. Policy strictness ALL_PLATFORMS requires a calibrated audio detector for every platform.`, assessment };
  }
  return { blocked: false, code: "CALIBRATION_GAP_RECORDED", message: `${assessment.reason}. This is a calibration gap, not a clean bill of health.`, assessment };
}
