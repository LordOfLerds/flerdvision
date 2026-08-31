import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { BENIGN_OVERLAY_CONFIRM_LABELS, OVERLAY_DISMISS_FORBIDDEN_WORDS } from "../dist/adapters/browser/autonomous-surface-explorer.js";

// After the first upload of a fresh profile Instagram lays a one-shot info dialog over the create
// flow ("Videobeiträge sind jetzt Reels", captured in the qualification evidence). It absorbs the
// trusted clicks aimed at the dialog underneath: three NEXT clicks reported success while the
// flow never advanced, and CAPTION stayed unreachable. Every fresh profile hits this once.

const source = readFileSync(new URL("../src/adapters/browser/autonomous-surface-explorer.ts", import.meta.url).pathname, "utf8");

test("the confirm allowlist is exact and contains no flow or publish vocabulary", () => {
  assert.ok(BENIGN_OVERLAY_CONFIRM_LABELS.includes("OK"), "the observed overlay confirms with OK");
  for (const label of BENIGN_OVERLAY_CONFIRM_LABELS) {
    for (const word of OVERLAY_DISMISS_FORBIDDEN_WORDS) {
      assert.notEqual(label.toLocaleLowerCase("en-US"), word.toLocaleLowerCase("en-US"),
        `${label} must never double as flow/publish vocabulary`);
    }
  }
});

test("every final-action word of every platform blocks dismissal", () => {
  // finalLocators uses these names; a dialog containing any of them must never be auto-dismissed.
  for (const word of ["Teilen", "Share", "Post", "Posten", "Publish", "Veröffentlichen"]) {
    assert.ok(OVERLAY_DISMISS_FORBIDDEN_WORDS.includes(word), `${word} missing from the forbidden list`);
  }
  // The create dialog itself advances with these; dismissing it would destroy the prepared state.
  for (const word of ["Weiter", "Next", "Continue", "Fortfahren"]) {
    assert.ok(OVERLAY_DISMISS_FORBIDDEN_WORDS.includes(word), `${word} missing from the forbidden list`);
  }
});

test("dismissal only ever targets dialog-like containers and skips those with inputs", () => {
  assert.match(source, /querySelectorAll\('\[role="dialog"\], \[role="alertdialog"\]'\)/);
  assert.match(source, /input\[type="file"\], textarea, \[contenteditable="true"\]/);
});

test("dismissal runs before the opening steps, after upload, and inside the continue loop", () => {
  // A fresh account shows enable-notifications over the create control before any click; the
  // post-upload dismissal cannot reach that.
  const openingIndex = source.indexOf("for (const step of openingSteps(");
  const beforeOpening = source.slice(openingIndex - 1400, openingIndex);
  assert.match(beforeOpening, /dismissBenignOverlay/);
  const uploadIndex = source.indexOf("The first upload on a fresh profile summons");
  const loopIndex = source.indexOf("for (let nextIndex = 1;");
  assert.ok(uploadIndex > 0 && uploadIndex < loopIndex, "a dismissal attempt must precede the field search");
  const loopBody = source.slice(loopIndex, loopIndex + 400);
  assert.match(loopBody, /dismissBenignOverlay/);
});

test("a dismissed overlay leaves a journal trace", () => {
  assert.match(source, /stepKey: "DISMISS_OVERLAY"/);
  assert.match(source, /Dismissed benign overlay/);
});

test("the final action step itself gains no dismissal", () => {
  // Between locating FINAL_ACTION and recording it, nothing may click anything away.
  const finalIndex = source.indexOf('stepKey: "FINAL_ACTION"');
  const tail = source.slice(finalIndex, finalIndex + 700);
  assert.doesNotMatch(tail, /dismissBenignOverlay/);
});

test("draft discard confirms only exact discard labels and shares no final vocabulary", async () => {
  const { DISCARD_CONFIRM_LABELS } = await import("../dist/adapters/browser/autonomous-surface-explorer.js");
  for (const label of DISCARD_CONFIRM_LABELS) {
    for (const word of ["Teilen", "Share", "Post", "Posten", "Publish", "Veröffentlichen", "Weiter", "Next"]) {
      assert.notEqual(label.toLocaleLowerCase("en-US"), word.toLocaleLowerCase("en-US"));
    }
  }
  const qual = readFileSync(new URL("../src/application/autonomous-surface-qualification.ts", import.meta.url).pathname, "utf8");
  assert.match(qual, /await discardPreparedDraft\(session\)\.catch/);
  assert.match(qual, /await discardPreparedDraft\(replaySession\)\.catch/);
});

test("a late promo overlay over the caption is cleared and the fill retried", () => {
  const idx = source.lastIndexOf('step.action === "FILL_CAPTION" || step.action === "FILL_TITLE"');
  const block = source.slice(idx, idx + 3000);
  assert.match(block, /Refusing to click/);
  assert.match(block, /const benign = await this\.dismissBenignOverlay\(journal\)\.catch\(\(\) => false\);/);
  assert.match(block, /const declined = await declineFeatureOptIn\(this\.session, journal\)\.catch\(\(\) => false\);/);
  assert.match(block, /if \(!benign && !declined\)/);
  assert.match(block, /attempt >= 2/);
  // A dismissed modal leaves its backdrop behind, just as opaque to a click as the dialog was.
  assert.match(block, /role="dialog"\], \[role="alertdialog"\]'\)\)\.some\(visible\)/);
});

test("a feature opt-in offer is declined, never enabled", async () => {
  const { FEATURE_OPT_IN_DECLINE_LABELS, FEATURE_OPT_IN_MARKERS } = await import("../dist/adapters/browser/autonomous-surface-explorer.js");
  // TikTok's "Automatische Inhaltsprüfungen aktivieren?" blocks the compose surface and offers
  // only Einschalten / Abbrechen. Enabling changes the account, so only declining is allowed.
  for (const label of FEATURE_OPT_IN_DECLINE_LABELS) {
    assert.ok(!/einschalten|turn on|enable|aktivieren/i.test(label), `${label} must never enable a feature`);
  }
  assert.ok(FEATURE_OPT_IN_MARKERS.some((m) => "automatische inhaltsprüfungen aktivieren?".includes(m)));
  const idx = source.indexOf("export async function declineFeatureOptIn");
  const block = source.slice(idx, idx + 2600);
  // Same guards as every other dismissal: visible only, never over inputs, forbidden words block.
  assert.match(block, /input\[type="file"\], textarea, \[contenteditable="true"\]/);
  assert.match(block, /labels\.some\(\(label\) => forbidden\.some\(\(word\) => label === word\)\)/);
  // Clicking by name alone hit a hidden twin in another mounted dialog.
  assert.match(block, /decline\.setAttribute\('data-flerdvision-decline', '1'\)/);
  assert.match(block, /rect\.width > 0 && rect\.height > 0/);
});

test("an unfinished product tour is acknowledged like any other benign overlay", () => {
  // TikTok's react-joyride overlay covers the page with pointer-events enabled: the caption
  // refusal named an empty presentation layer, not a dialog, so the scan never saw it.
  assert.match(source, /react-joyride__tooltip, \[data-test-id="tooltip"\]/);
  const idx = source.indexOf("private async dismissBenignOverlay");
  const block = source.slice(idx, idx + 1800);
  // The tour tooltip goes through the same guards as every other container.
  assert.match(block, /forbid\.some\(\(word\) => text\.includes/);
  assert.match(block, /input\[type="file"\], textarea, \[contenteditable="true"\]/);
});

test("a control is matched by its label or its visible text, never by a substring", () => {
  // TikTok's tour tooltip carries stylesheet text in aria-label; a single name source stopped
  // matching entirely. Exactness is preserved: both candidates go through the same Set lookups.
  const idx = source.indexOf("private async dismissBenignOverlay");
  const block = source.slice(idx, idx + 2200);
  assert.match(block, /const names = \(el\) => \[normalize\(el\.getAttribute\("aria-label"\)\), normalize\(el\.textContent\)\]/);
  assert.match(block, /names\(el\)\.some\(\(value\) => decline\.has\(value\)\)/);
  assert.match(block, /names\(el\)\.some\(\(value\) => allow\.has\(value\)\)/);
});
