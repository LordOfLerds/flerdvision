import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Run 11 reached the compose stage -- video left, caption right, Teilen visible -- and failed to
// find the caption field. The live element is role=textbox, contenteditable, aria-label
// "Bildunterschrift verfassen …" (U+2026, space before it), backed by a Lexical editor whose
// internal state ignores synthetic textContent writes exactly as the platform ignores synthetic
// clicks.

const explorer = readFileSync(new URL("../src/adapters/browser/autonomous-surface-explorer.ts", import.meta.url).pathname, "utf8");
const driver = readFileSync(new URL("../src/adapters/browser/dom-ui-driver.ts", import.meta.url).pathname, "utf8");

test("the observed caption label is an exact candidate", () => {
  assert.match(explorer, /Bildunterschrift verfassen …/);
});

test("contains fallbacks exist for the caption textbox and come after the exact names", () => {
  const block = explorer.slice(explorer.indexOf("function captionLocators"), explorer.indexOf("function captionLocators") + 900);
  assert.match(block, /role: "textbox", value: "Bildunterschrift", exact: false/);
  assert.match(block, /role: "textbox", value: "caption", exact: false/);
  assert.ok(block.indexOf('named("textbox"') < block.indexOf('exact: false'), "exact candidates must be tried first");
});

test("editable targets are typed through the browser input pipeline, not textContent", () => {
  assert.match(driver, /this\.session\.insertText\(value\)/);
  assert.match(driver, /kind\.editable && this\.session\.clickAt && this\.session\.insertText/);
});

test("the editable fill proves focus before typing", () => {
  assert.match(driver, /document\.activeElement === el \|\| el\.contains\(document\.activeElement\)/);
  assert.match(driver, /did not take focus/);
});

test("the editable fill proves the text arrived by reading it back", () => {
  // A caption that only LOOKS set surfaces as an empty caption on a real publication.
  assert.match(driver, /collapse\(readback\)\.includes\(collapse\(value\)\)/);
  assert.match(driver, /readback mismatch/);
});

test("session fakes without insertText keep the legacy fill path", () => {
  const fillBlock = driver.slice(driver.indexOf("async fill("), driver.indexOf("async fill(") + 5600);
  assert.match(fillBlock, /el\.isContentEditable/);
  assert.match(fillBlock, /dispatchEvent\(new InputEvent\('input'/);
});

test("the readback ignores whitespace entirely but never a missing character", () => {
  // DraftJS turns the caption's blank line into a separate block: the words arrive complete
  // while the exact substring check failed. Collapsing whitespace on BOTH sides keeps the
  // proof strict about content and silent about layout.
  const fillBlock = driver.slice(driver.indexOf("async fill("), driver.indexOf("async fill(") + 4200);
  assert.match(fillBlock, /const collapse = /);
  assert.match(fillBlock, /collapse\(readback\)\.includes\(collapse\(value\)\)/);
});

test("a pre-filled caption is cleared the way a person clears it", () => {
  // TikTok pre-fills the description from the filename, and DraftJS ignored text inserted next
  // to content it already owned: the readback proved the caption never arrived.
  const fillBlock = driver.slice(driver.indexOf("async fill("), driver.indexOf("async fill(") + 4600);
  assert.match(fillBlock, /this\.session\.pressKey\("a", \{ meta: true \}\)/);
  assert.match(fillBlock, /this\.session\.pressKey\("Delete"\)/);
  // Only when there is something to clear -- an empty field is never touched.
  assert.match(fillBlock, /if \(existing\.trim\(\)\.length > 0\)/);
});

test("text is typed as real keystrokes where the editor owns its content model", () => {
  const fillBlock = driver.slice(driver.indexOf("async fill("), driver.indexOf("async fill(") + 5600);
  assert.match(fillBlock, /if \(this\.session\.typeText\)/);
  assert.match(fillBlock, /this\.session\.typeText\(value/);
  // The old bulk path stays for sessions without the capability.
  assert.match(fillBlock, /this\.session\.insertText\(value\)/);
});

test("the fill targets the visible field when a selector matches several", async () => {
  const { readFileSync } = await import("node:fs");
  const explorer = readFileSync(new URL("../src/adapters/browser/autonomous-surface-explorer.ts", import.meta.url).pathname, "utf8");
  // YouTube gives the title and the description the same id: the first match was off-screen and
  // read as "occluded" no matter how long the run waited.
  const idx = explorer.lastIndexOf('step.action === "FILL_CAPTION" || step.action === "FILL_TITLE"');
  const block = explorer.slice(idx, idx + 1800);
  assert.match(block, /data-flerdvision-field/);
  assert.match(block, /document\.elementFromPoint/);
});

test("a field outside the dialog's scroll window is brought into view first", () => {
  const explorer = readFileSync(new URL("../src/adapters/browser/autonomous-surface-explorer.ts", import.meta.url).pathname, "utf8");
  // Its rect is off-screen otherwise and the point test hits whatever sits at those coordinates.
  const idx = explorer.lastIndexOf("data-flerdvision-field");
  const block = explorer.slice(Math.max(0, idx - 2000), idx + 800);
  assert.match(block, /element\.scrollIntoView\(\{ block: "center", inline: "center" \}\)/);
});
