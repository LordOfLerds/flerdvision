import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Live evidence (TikTok, 2026-08-31): the visibility control is a combobox whose accessible name
// is its CURRENT VALUE ("Alle"); the question "Wer kann diesen Beitrag sehen" sits in a separate
// label element. A question-only search could never find it, and the zero-viewer setting the
// private test depends on failed with "Visibility option only_you could not be located".

const source = readFileSync(new URL("../src/adapters/browser/autonomous-surface-settings.ts", import.meta.url).pathname, "utf8");

test("the control is also found by the setting it currently shows", () => {
  const idx = source.indexOf("function visibilityControlLocators");
  const block = source.slice(idx, idx + 2200);
  assert.match(block, /const currentValues = \[/);
  assert.match(block, /"Alle"/);
  assert.match(block, /role\("combobox", currentValues\)/);
});

test("every value the option labels can select is also a recognizable current value", () => {
  const idx = source.indexOf("function visibilityControlLocators");
  const values = source.slice(idx, idx + 2200);
  for (const label of ["Everyone", "Alle", "Only you", "Nur du", "Private", "Privat", "Unlisted"]) {
    assert.ok(values.includes(`"${label}"`), `${label} must be recognizable as a current value`);
  }
});

test("only_you still maps to the exact German option TikTok shows", () => {
  const idx = source.indexOf("function visibilityLabels");
  const block = source.slice(idx, idx + 600);
  assert.match(block, /"Nur du"/);
});

test("interactive candidates rank before the plain question text", () => {
  const idx = source.indexOf("function visibilityControlLocators");
  const block = source.slice(idx, idx + 1600);
  const combobox = block.indexOf('button[role=');
  const plainText = block.indexOf("...text(names)");
  // Clicking the label opened nothing and consumed the attempt; the option list never appeared.
  assert.ok(combobox > 0 && combobox < plainText, "the real control must be preferred over its label");
});

test("a structural combobox candidate exists, guarded by the value readback", () => {
  const idx = source.indexOf("function visibilityControlLocators");
  const block = source.slice(idx, idx + 1800);
  // TikTok's control carries no usable accessible name; structure finds it, and picking the
  // wrong one still fails loudly because the setting is read back afterwards.
  assert.match(block, /button\[role=\\"combobox\\"\]/);
  assert.match(source, /Visibility readback failed: expected/);
});

test("a control that vanishes between probe and use is re-resolved once", () => {
  const idx = source.indexOf("Could not locate required visibility setting");
  const block = source.slice(idx, idx + 900);
  // The settings section re-renders constantly: a candidate chosen with a short probe failed a
  // full five-second locate moments later.
  assert.match(block, /const refreshed = await this\.firstPresent\(candidates, 5000\);/);
  assert.match(block, /if \(!refreshed\) throw error;/);
});

test("the replay path accepts the localized option the platform actually shows", async () => {
  const runner = readFileSync(new URL("../src/adapters/browser/platform-execution-runner.ts", import.meta.url).pathname, "utf8");
  // TikTok shows "Nur du" for only_you: comparing against the raw contract value alone could
  // never match, so the replay failed on a setting exploration had just applied.
  assert.match(runner, /visibilityLabels\(String\(expected\)\)\.map\(normalized\)/);
  const { visibilityLabels } = await import("../dist/adapters/browser/autonomous-surface-settings.js");
  assert.ok(visibilityLabels("only_you").includes("Nur du"));
  assert.ok(visibilityLabels("private").includes("Privat"));
});

test("the replay waits for the option list the click opens", () => {
  const runner = readFileSync(new URL("../src/adapters/browser/platform-execution-runner.ts", import.meta.url).pathname, "utf8");
  // A single immediate look found nothing: the list renders after the click.
  assert.match(runner, /const pick=async\(\):Promise<boolean>/);
  assert.match(runner, /Date\.now\(\)\+8_000/);
});

test("a control that shows its value as text can still be read back", () => {
  const runner = readFileSync(new URL("../src/adapters/browser/platform-execution-runner.ts", import.meta.url).pathname, "utf8");
  const idx = runner.indexOf("private async readEnum");
  const block = runner.slice(idx, idx + 1400);
  // TikTok's visibility button carries no value attribute at all: every attribute-based read
  // returned nothing and the readback failed on a setting that had in fact been applied.
  assert.match(block, /const own=\(el\.textContent\|\|''\)\.trim\(\);/);
  // Bounded so a whole panel's prose can never masquerade as a value.
  assert.match(block, /own\.length<=40/);
});

test("a radio-based visibility surface is handled before the combobox search", () => {
  // YouTube's last wizard screen lists Öffentlich / Nicht gelistet / Privat as radios; the
  // combobox search settled on the section heading and read "Sichtbarkeit" as the value.
  const idx = source.indexOf("Some surfaces expose visibility as radio buttons");
  const block = source.slice(idx, idx + 1800);
  assert.match(block, /const radio = await this\.firstPresent\(radioCandidates, 2500\);/);
  assert.match(block, /aria-checked"\) === "true"/);
  const radioPath = source.indexOf("const radio = await this.firstPresent");
  const comboPath = source.indexOf("await this.proposedLocators(input.intent, \"VISIBILITY\"");
  assert.ok(radioPath > 0 && radioPath < comboPath, "radios must be considered first");
});
