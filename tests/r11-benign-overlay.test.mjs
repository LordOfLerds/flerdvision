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

test("dismissal only ever targets a role=dialog and skips dialogs with inputs", () => {
  assert.match(source, /querySelectorAll\('\[role="dialog"\]'\)/);
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
