import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The exploration pins the one field a person would type into by tagging it with
// data-flerdvision-field. That attribute lives only in the exploring page. It was being written
// into the recorded contract as the route's primary locator, so every replay opened a fresh page
// where nothing carried it and the route survived only on its fallbacks -- until TikTok's caption
// placeholder shifted and the fallbacks missed too. The contract must record the real selector.

const source = readFileSync(new URL("../src/adapters/browser/autonomous-surface-explorer.ts", import.meta.url).pathname, "utf8");

test("retarget reports which selector it tagged", () => {
  assert.match(source, /const retarget = async \(\): Promise<string \| null>/);
  assert.match(source, /element\.setAttribute\('data-flerdvision-field', '1'\);\s*\n\s*return selector;/);
});

test("the marker drives typing while the real selector is recorded", () => {
  const idx = source.indexOf("const tagged = await retarget();");
  assert.ok(idx > 0, "retarget result must be captured");
  const block = source.slice(idx, idx + 400);
  assert.match(block, /recorded = \{ kind: "css", value: tagged \}/);
  assert.match(block, /selected = \{ kind: "css", value: '\[data-flerdvision-field="1"\]' \}/);
});

test("the journal and the contract both carry the durable locator", () => {
  assert.match(source, /const detail = `\$\{recorded\.kind\}:\$\{recorded\.value\}`/);
  assert.match(source, /return \{ locator: recorded, fallbacks \}/);
  // Nothing else may hand the transient marker onward.
  assert.doesNotMatch(source, /return \{ locator: selected, fallbacks \}/);
});

test("the YouTube audience answer is recorded by its wording, never by the page marker", () => {
  const idx = source.indexOf('stepKey: "AUDIENCE", label: "Made-for-kids declaration"');
  const block = source.slice(idx, idx + 1200);
  assert.match(block, /const recordedAudience = tagged \? durableAudience\[0\]! : audience\.locator/);
  assert.match(block, /locator: recordedAudience, fallbackLocators: recordedFallbacks/);
  assert.doesNotMatch(block, /locator: audience\.locator, fallbackLocators: audience\.fallbacks/);
});

test("the YouTube visibility radio is recorded by its label, never by the page marker", () => {
  const settings = readFileSync(new URL("../src/adapters/browser/autonomous-surface-settings.ts", import.meta.url).pathname, "utf8");
  assert.match(settings, /recordedRadio = \{ kind: "text", value: tagged, exact: true \}/);
  assert.match(settings, /stepKey: "VISIBILITY", label: "Visibility setting", actionMode: "OBSERVE_ACTION", locator: recordedRadio \?\? radio/);
});
