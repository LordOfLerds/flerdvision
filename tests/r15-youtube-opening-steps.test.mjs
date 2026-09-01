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
  const block = source.slice(idx, idx + 1600);
  assert.match(block, /await sleep\(1500\);/);
  assert.match(block, /if \(!\/\^Refusing to click\/\.test\(firstMessage\)\) throw firstError;/);
  // A genuinely covered target still refuses on the second try and is handled as before.
  assert.match(block, /outcome: "SKIPPED"/);
});

test("the second click attempt targets the visible element that owns its own centre", () => {
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
