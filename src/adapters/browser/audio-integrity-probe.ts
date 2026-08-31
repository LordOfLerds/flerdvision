import type { BrowserPageSessionPort } from "../../domain/browser-identity-ports.js";
import {
  assessAudioIntegrity,
  audioIntegrityGateDecision,
  DEFAULT_AUDIO_INTEGRITY_POLICY,
  NO_AUDIO_DETECTOR,
  type AudioIntegrityDecision,
  type AudioIntegrityObservation,
  type AudioIntegrityPolicy
} from "../../domain/audio-integrity.js";

/**
 * Read-only audio probes for live compose surfaces.
 *
 * Every expression below only READS (querySelectorAll / textContent). Nothing here clicks, sets an
 * attribute or mutates the page: a detected sound must reach a human, never a repair click into an
 * editor this project has never observed.
 */

/**
 * TikTok web composer, calibrated 2026-08-31 against 34 live qualification snapshots
 * under `evidence/headless/surface/qualification_<id>/<ts>-autonomous-caption.html`,
 * `-autonomous-final_action.html` and `-autonomous-setting-<key>.html`.
 *
 * Observed shape, identical in every snapshot:
 *   <div class="jsx-… sound-container">
 *     <div class="jsx-… music-icon"><svg …/></div>
 *     <div class="jsx-… sound"><div class="jsx-… marquee">
 *       <p>Original-Sound - luca e</p><p>Original-Sound - luca e</p>   <-- marquee duplicates
 *     </div></div>
 *   </div>
 * Exactly one `.sound-container` exists on the compose page, inside the preview card whose
 * `.caption` holds the media being uploaded -- so the label describes THIS draft, not a feed item.
 *
 * `[data-button-name="sounds"]` (with `data-default-left-menu="MusicPanel"`) is also always
 * present. It is the ENTRANCE to the music panel, not a selection, and is recorded as a control
 * only. Treating it as an attached sound would block every TikTok run.
 */
export const TIKTOK_AUDIO_DETECTOR_ID = "tiktok-compose-sound-container/2026-08-31";

const TIKTOK_AUDIO_PROBE = `(() => {
  const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim().slice(0, 200);
  const containers = Array.from(document.querySelectorAll(".sound-container"));
  const labels = [];
  for (const container of containers) {
    const paragraphs = Array.from(container.querySelectorAll("p")).map((node) => clean(node.textContent)).filter(Boolean);
    if (paragraphs.length > 0) { labels.push(...paragraphs); continue; }
    const sound = container.querySelector(".sound");
    const fallback = clean(sound ? sound.textContent : container.textContent);
    if (fallback) labels.push(fallback);
  }
  const controls = Array.from(document.querySelectorAll('[data-button-name="sounds"], [data-default-left-menu="MusicPanel"]'))
    .map((node) => clean(node.getAttribute("data-button-name") || node.getAttribute("data-default-left-menu")))
    .filter(Boolean);
  return { labels, controls: Array.from(new Set(controls)) };
})()`;

/** Platforms with a live-calibrated detector. Everything else honestly reports a calibration gap. */
const PROBES: Readonly<Record<string, { detectorId: string; expression: string }>> = {
  tiktok: { detectorId: TIKTOK_AUDIO_DETECTOR_ID, expression: TIKTOK_AUDIO_PROBE }
  // instagram: NOT CALIBRATED. Every Instagram compose snapshot in the evidence corpus
  // (upload_media / next_1 / next_2 / caption / final_action / setting-*) contains no sound, music
  // or audio affordance at all -- the only match is the unrelated CSS custom property
  // `--igd-chat-tabs-audio-player-width`. There is nothing to key a detector on without a live
  // snapshot of Instagram's reel editor audio tab. Guessing a selector here would produce a
  // detector that silently passes, which is worse than an admitted gap.
  // youtube: NOT CALIBRATED. No compose-surface audio evidence exists.
};

export async function probeAudioIntegrity(session: BrowserPageSessionPort, platform: string, observedAt: string): Promise<AudioIntegrityObservation> {
  const probe = PROBES[platform];
  if (!probe) return { platform, detectorId: NO_AUDIO_DETECTOR, observedAt, attachedSoundLabels: [], soundControls: [] };
  try {
    const raw = await session.evaluate<{ labels?: readonly string[]; controls?: readonly string[] }>(probe.expression);
    return {
      platform,
      detectorId: probe.detectorId,
      observedAt,
      attachedSoundLabels: raw?.labels ?? [],
      soundControls: raw?.controls ?? []
    };
  } catch (error) {
    // A probe that cannot run says nothing about the audio state, so it must not read as "clean".
    return { platform, detectorId: probe.detectorId, observedAt, attachedSoundLabels: [], soundControls: [], probeError: error instanceof Error ? error.message : String(error) };
  }
}

export class AudioIntegrityViolationError extends Error {
  readonly decision: AudioIntegrityDecision;
  constructor(decision: AudioIntegrityDecision) {
    super(decision.message);
    this.name = "AudioIntegrityViolationError";
    this.decision = decision;
  }
}

/**
 * Probes the live surface and applies the gate. Throws only when the decision blocks; the caller
 * gets the full decision back otherwise so a calibration gap can still be journalled honestly.
 */
export async function assertOriginalAudio(
  session: BrowserPageSessionPort,
  platform: string,
  observedAt: string,
  policy: AudioIntegrityPolicy = DEFAULT_AUDIO_INTEGRITY_POLICY
): Promise<AudioIntegrityDecision> {
  const decision = audioIntegrityGateDecision(assessAudioIntegrity(await probeAudioIntegrity(session, platform, observedAt)), policy);
  if (decision.blocked) throw new AudioIntegrityViolationError(decision);
  return decision;
}
