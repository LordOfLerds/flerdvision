import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Live evidence 2026-09-01: the YouTube run stood on the Studio dashboard with zero file inputs.
// The single opening step mixed the create control and the upload menu entry, so the create
// button always won the match and the menu entry was never clicked -- the dialog never opened.

const source = readFileSync(new URL("../src/adapters/browser/autonomous-surface-explorer.ts", import.meta.url).pathname, "utf8");

test("youtube opens the create menu and then chooses upload", () => {
  const idx = source.indexOf("YouTube Studio needs two steps");
  const block = source.slice(idx, idx + 1200);
  assert.match(block, /stepKey: "OPEN_CREATE", label: "Open create menu", action: "CLICK", required: true/);
  assert.match(block, /stepKey: "OPEN_UPLOAD", label: "Choose video upload"/);
  const create = block.indexOf('"OPEN_CREATE"');
  const upload = block.indexOf('"OPEN_UPLOAD"');
  assert.ok(create > 0 && create < upload, "the menu must be opened before its entry is chosen");
});

test("the upload entry is optional so a surface that skips the menu still works", () => {
  const idx = source.indexOf('stepKey: "OPEN_UPLOAD", label: "Choose video upload"');
  const block = source.slice(idx, idx + 400);
  assert.match(block, /required: false/);
});

test("a click refused during a menu animation gets one settle and one retry", () => {
  // YouTube's create menu refused "Videos hochladen" as occluded by its neighbour
  // "Livestream starten" while still animating open.
  const idx = source.indexOf('if (step.action === "CLICK") {');
  const block = source.slice(idx, idx + 4200);
  assert.match(block, /await sleep\(1500\);/);
  assert.match(block, /if \(!\/\^Refusing to click\/\.test\(firstMessage\)\) throw firstError;/);
  // A genuinely covered target still refuses on the second try and is handled as before.
  assert.match(block, /outcome: "SKIPPED"/);
});

test("clicks target the visible element that owns its own centre", () => {
  // Name-based locating settled on a mounted-but-stacked twin: the entry sat plainly visible on
  // screen while the click point belonged to its neighbour.
  assert.match(source, /async function clickExactVisibleByName/);
  const idx = source.indexOf("async function clickExactVisibleByName");
  const block = source.slice(idx, idx + 1600);
  assert.match(block, /document\.elementFromPoint\(rect\.left \+ rect\.width \/ 2, rect\.top \+ rect\.height \/ 2\)/);
  assert.match(block, /hit === candidate \|\| candidate\.contains\(hit\) \|\| hit\.contains\(candidate\)/);
  // Exact names only -- never a substring, so an unrelated control can never be adopted.
  assert.match(block, /wanted\.has\(name\)/);
});

test("a wizard surface is walked until the final control is on screen", () => {
  // YouTube Studio asks for details, then checks, then visibility: the final control is three
  // clicks away and the run reported it missing instead of walking there.
  const idx = source.indexOf("Wizard surfaces put the final control");
  const block = source.slice(idx, idx + 1400);
  assert.match(block, /advance <= 4/);
  assert.match(block, /if \(await this\.workingLocator\(finalCandidates, true, 2500\)\) break;/);
  assert.match(block, /stepKey: `ADVANCE_\$\{advance\}`/);
  // The advance step is optional: a surface that already shows the final control walks nowhere.
  assert.match(block, /required: false/);
});

test("the YouTube final control is reachable by its exact visible text too", () => {
  // The Save button was plainly in the DOM at failure time while the name-based candidates
  // missed it: Studio wraps it in a custom element whose accessible name is not computed.
  const idx = source.indexOf("Studio's final control is");
  const block = source.slice(idx, idx + 500);
  assert.match(block, /text\(\["Publish", "Veröffentlichen", "Save", "Speichern"\]\)/);
});

test("final-action candidates never widen to contains matching", () => {
  const idx = source.indexOf("function finalLocators");
  const block = source.slice(idx, idx + 900);
  assert.doesNotMatch(block, /namedContains/);
  assert.doesNotMatch(block, /exact: false/);
});

test("the boundary waits for a final control that is actually pressable", () => {
  // YouTube keeps Save aria-disabled while it processes the upload: the control was in the DOM
  // the whole time, and reaching a boundary that cannot be pressed is not reaching it.
  const idx = source.indexOf("keeps its final control disabled");
  const block = source.slice(idx, idx + 1600);
  assert.match(block, /Date\.now\(\) \+ 240_000/);
  assert.match(block, /element\.hasAttribute\("disabled"\) \|\| element\.getAttribute\("aria-disabled"\) === "true"/);
  // Read-only: the wait never clicks anything.
  assert.doesNotMatch(block, /\.click\(\)/);
});

test("the visible-element search pierces shadow roots", () => {
  // Studio and TikTok place controls inside shadow roots, which a plain querySelectorAll cannot
  // see: the search found nothing and the stacked-twin problem stayed unsolved.
  const idx = source.indexOf("async function clickExactVisibleByName");
  const block = source.slice(idx, idx + 1800);
  assert.match(block, /if \(element\.shadowRoot\) collect\(element\.shadowRoot, out\);/);
});
