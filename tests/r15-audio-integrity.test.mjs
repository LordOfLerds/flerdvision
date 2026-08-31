import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  assessAudioIntegrity,
  audioIntegrityGateDecision,
  isOriginalAudioLabel,
  NO_AUDIO_DETECTOR,
  DEFAULT_AUDIO_INTEGRITY_POLICY
} from "../dist/domain/audio-integrity.js";
import {
  assertOriginalAudio,
  AudioIntegrityViolationError,
  probeAudioIntegrity,
  TIKTOK_AUDIO_DETECTOR_ID
} from "../dist/adapters/browser/audio-integrity-probe.js";

// Operator rule: an automatically published video must post with its ORIGINAL audio. No platform
// suggestion, no library track.
//
// Live evidence (TikTok web composer, 2026-08-31, 34 qualification snapshots under
// evidence/headless/surface): the compose preview card always renders exactly one
// `.sound-container` whose marquee duplicates one label -- `Original-Sound - luca e` -- next to the
// caption of the very file being uploaded. `[data-button-name="sounds"]` with
// `data-default-left-menu="MusicPanel"` is always present too, but that is the ENTRANCE to the
// music panel, never a selection.

const AT = "2026-08-31T08:00:00.000Z";
const observation = (over = {}) => ({ platform: "tiktok", detectorId: TIKTOK_AUDIO_DETECTOR_ID, observedAt: AT, attachedSoundLabels: [], soundControls: [], ...over });

test("the exact label the live TikTok composer shows reads as original audio", () => {
  // Both marquee copies, verbatim from the live snapshots.
  const assessment = assessAudioIntegrity(observation({ attachedSoundLabels: ["Original-Sound - luca e", "Original-Sound - luca e"], soundControls: ["sounds", "MusicPanel"] }));
  assert.equal(assessment.verdict, "ORIGINAL_AUDIO_ONLY");
  assert.equal(assessment.observedLabel, "Original-Sound - luca e");
  assert.equal(audioIntegrityGateDecision(assessment).blocked, false);
});

test("the music-panel entrance alone is never treated as an attached sound", () => {
  // Blocking on the entrance would stop every TikTok run forever; it is present in all 34 snapshots.
  const assessment = assessAudioIntegrity(observation({ attachedSoundLabels: ["Original-Sound - luca e"], soundControls: ["sounds", "MusicPanel"] }));
  assert.equal(assessment.verdict, "ORIGINAL_AUDIO_ONLY");
});

test("an added track is a hard stop and is never removed automatically", () => {
  const assessment = assessAudioIntegrity(observation({ attachedSoundLabels: ["Sunroof - Nicky Youre & dazy"] }));
  assert.equal(assessment.verdict, "ADDED_SOUND_DETECTED");
  const decision = audioIntegrityGateDecision(assessment);
  assert.equal(decision.blocked, true);
  assert.equal(decision.code, "ADDED_SOUND_BLOCKED");
  assert.match(decision.message, /Sunroof - Nicky Youre & dazy/);
  // The operator removes it; clicking through an unobserved editor is exactly what AGENTS.md forbids.
  assert.match(decision.message, /Remove the sound in the platform UI/);
  assert.match(decision.message, /never removes a sound on its own/);
});

test("a missing sound label is unreadable state, not a clean bill of health", () => {
  // Silence on a surface calibrated to always name its sound means drift, not "no sound attached".
  const assessment = assessAudioIntegrity(observation({ attachedSoundLabels: [] }));
  assert.equal(assessment.verdict, "STATE_UNREADABLE");
  assert.equal(audioIntegrityGateDecision(assessment).blocked, true);
});

test("competing sound labels are ambiguous and fail closed", () => {
  const assessment = assessAudioIntegrity(observation({ attachedSoundLabels: ["Original-Sound - luca e", "Sunroof - Nicky Youre"] }));
  assert.equal(assessment.verdict, "STATE_UNREADABLE");
  assert.match(assessment.reason, /ambiguous/);
  assert.equal(audioIntegrityGateDecision(assessment).blocked, true);
});

test("a probe that could not run never reads as original audio", () => {
  const assessment = assessAudioIntegrity(observation({ probeError: "Execution context was destroyed" }));
  assert.equal(assessment.verdict, "STATE_UNREADABLE");
  assert.equal(audioIntegrityGateDecision(assessment).blocked, true);
});

test("an uncalibrated platform admits a calibration gap instead of claiming a pass", () => {
  const assessment = assessAudioIntegrity(observation({ platform: "instagram", detectorId: NO_AUDIO_DETECTOR }));
  assert.equal(assessment.verdict, "NO_CALIBRATED_DETECTOR");
  const relaxed = audioIntegrityGateDecision(assessment, DEFAULT_AUDIO_INTEGRITY_POLICY);
  assert.equal(relaxed.blocked, false);
  assert.equal(relaxed.code, "CALIBRATION_GAP_RECORDED");
  // A gap must never be reported as proof that no sound was added.
  assert.match(relaxed.message, /not a clean bill of health/);
  const strict = audioIntegrityGateDecision(assessment, { requireOriginalAudio: true, strictness: "ALL_PLATFORMS" });
  assert.equal(strict.blocked, true);
  assert.equal(strict.code, "CALIBRATION_GAP_BLOCKED");
});

test("the default policy enforces the operator rule wherever a detector is calibrated", () => {
  assert.equal(DEFAULT_AUDIO_INTEGRITY_POLICY.requireOriginalAudio, true);
  assert.equal(DEFAULT_AUDIO_INTEGRITY_POLICY.strictness, "CALIBRATED_PLATFORMS");
});

test("disabling the check is explicit and never silently downgrades a detection", () => {
  const assessment = assessAudioIntegrity(observation({ attachedSoundLabels: ["Sunroof - Nicky Youre"] }));
  const decision = audioIntegrityGateDecision(assessment, { requireOriginalAudio: false, strictness: "CALIBRATED_PLATFORMS" });
  assert.equal(decision.blocked, false);
  assert.equal(decision.code, "CHECK_DISABLED");
  // The underlying verdict is preserved so evidence still shows what the surface actually had.
  assert.equal(decision.assessment.verdict, "ADDED_SOUND_DETECTED");
});

test("original-audio labels are recognised in the observed locale and in English", () => {
  assert.ok(isOriginalAudioLabel("Original-Sound - luca e"));
  assert.ok(isOriginalAudioLabel("original sound - luca e"));
  assert.ok(isOriginalAudioLabel("Originalton - luca e"));
  // An unverified locale fails closed: a false stop is acceptable, a false pass is not.
  assert.equal(isOriginalAudioLabel("Son original - luca e"), false);
  // A bare prefix with no author is not the observed shape either.
  assert.equal(isOriginalAudioLabel("Original-Sound"), false);
});

test("the TikTok probe reads the marquee paragraphs the live surface renders", async () => {
  const session = { evaluate: async () => ({ labels: ["Original-Sound - luca e", "Original-Sound - luca e"], controls: ["sounds", "MusicPanel"] }) };
  const observed = await probeAudioIntegrity(session, "tiktok", AT);
  assert.equal(observed.detectorId, TIKTOK_AUDIO_DETECTOR_ID);
  assert.deepEqual([...observed.attachedSoundLabels], ["Original-Sound - luca e", "Original-Sound - luca e"]);
  assert.equal(assessAudioIntegrity(observed).verdict, "ORIGINAL_AUDIO_ONLY");
});

test("an uncalibrated platform is never probed at all", async () => {
  let evaluated = 0;
  const session = { evaluate: async () => { evaluated += 1; return {}; } };
  const observed = await probeAudioIntegrity(session, "instagram", AT);
  assert.equal(evaluated, 0, "no detector exists for Instagram; the page must not be touched");
  assert.equal(observed.detectorId, NO_AUDIO_DETECTOR);
});

test("assertOriginalAudio throws with the full decision when a sound is attached", async () => {
  const session = { evaluate: async () => ({ labels: ["Sunroof - Nicky Youre"], controls: [] }) };
  await assert.rejects(
    () => assertOriginalAudio(session, "tiktok", AT),
    (error) => {
      assert.ok(error instanceof AudioIntegrityViolationError);
      assert.equal(error.decision.code, "ADDED_SOUND_BLOCKED");
      assert.equal(error.decision.assessment.observedLabel, "Sunroof - Nicky Youre");
      return true;
    }
  );
});

test("a rejecting evaluate stops the run instead of passing it through", async () => {
  const session = { evaluate: async () => { throw new Error("Target closed"); } };
  await assert.rejects(() => assertOriginalAudio(session, "tiktok", AT), /Audio probe failed on tiktok: Target closed/);
});

const probeSource = readFileSync(new URL("../src/adapters/browser/audio-integrity-probe.ts", import.meta.url).pathname, "utf8");

test("the TikTok detector keys on the structure the live snapshots actually show", () => {
  assert.match(probeSource, /querySelectorAll\(["']\.sound-container["']\)/);
  assert.match(probeSource, /querySelectorAll\(["']p["']\)/);
  assert.match(probeSource, /data-button-name="sounds"/);
});

test("the audio probe only reads the page and can never change it", () => {
  const expression = probeSource.slice(probeSource.indexOf("const TIKTOK_AUDIO_PROBE"), probeSource.indexOf("/** Platforms with a live-calibrated detector"));
  for (const mutation of [".click(", "setAttribute", "removeAttribute", "innerHTML", "dispatchEvent", ".remove(", "scrollIntoView"]) {
    assert.ok(!expression.includes(mutation), `the audio probe must not ${mutation} -- removing a sound is a human decision`);
  }
});

const runnerSource = readFileSync(new URL("../src/adapters/browser/platform-execution-runner.ts", import.meta.url).pathname, "utf8");

test("the executor checks audio integrity before it reports the final boundary as reached", () => {
  const branch = runnerSource.slice(runnerSource.indexOf('if(action.operation==="FINAL_BOUNDARY")'), runnerSource.indexOf("reachedFinalActionBoundary:true,finalActionInvoked:false"));
  assert.match(branch, /await this\.guardOriginalAudio\(plan,identity,journal,artifactRefs\)/);
  // The boundary snapshot is captured first, so a violation is investigable.
  assert.ok(branch.indexOf("surface-execution-final-boundary") < branch.indexOf("guardOriginalAudio"));
});

const settingsSource = readFileSync(new URL("../src/adapters/browser/autonomous-surface-settings.ts", import.meta.url).pathname, "utf8");

test("the qualification leg guards audio after the settings and before the contract is sealed", () => {
  const guard = settingsSource.indexOf("await this.guardOriginalAudio(input, artifactRefs, journal)");
  const seal = settingsSource.indexOf("normalizeAutonomousSurfaceContract(enriched");
  assert.ok(guard > 0, "the settings leg must guard original audio");
  assert.ok(guard < seal, "the audio state must be read before the contract is sealed");
});
