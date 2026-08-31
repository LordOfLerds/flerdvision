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
  const block = source.slice(idx, idx + 1400);
  assert.match(block, /const currentValues = \[/);
  assert.match(block, /"Alle"/);
  assert.match(block, /role\("combobox", currentValues\)/);
});

test("every value the option labels can select is also a recognizable current value", () => {
  const idx = source.indexOf("function visibilityControlLocators");
  const values = source.slice(idx, idx + 1400);
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
  const combobox = block.indexOf('role("combobox", currentValues)');
  const plainText = block.indexOf("...text(names)");
  // Clicking the label opened nothing and consumed the attempt; the option list never appeared.
  assert.ok(combobox > 0 && combobox < plainText, "the real control must be preferred over its label");
});
