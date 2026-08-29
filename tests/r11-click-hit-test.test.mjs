import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Two real qualification runs failed because a trusted click landed where the target was not:
// once absorbed by an info overlay lying over the button, once on the dialog backdrop after the
// still-animating crop stage moved its Weiter button between rect-read and dispatch -- which
// Instagram answers with "Beitrag verwerfen?", destroying the prepared upload.

const source = readFileSync(new URL("../src/adapters/browser/dom-ui-driver.ts", import.meta.url).pathname, "utf8");

test("a trusted click verifies the element under the point is the target", () => {
  assert.match(source, /elementFromPoint\(x, y\)/);
  assert.match(source, /el === hit \|\| el\.contains\(hit\) \|\| hit\.contains\(el\)/);
});

test("a trusted click requires the rect to be stable across two reads", () => {
  assert.match(source, /getBoundingClientRect\(\)/);
  assert.match(source, /Math\.abs\(first\.x - second\.x\) > 1/);
  assert.match(source, /moved/);
});

test("persistent occlusion fails loudly and names the occluder", () => {
  assert.match(source, /Refusing to click .*occluded by|occluded by \$\{|occludedBy/s);
  assert.match(source, /Refusing to click \$\{descriptor\}/);
});

test("the wait is bounded, not open-ended", () => {
  assert.match(source, /Date\.now\(\) \+ 5_000/);
  assert.match(source, /Date\.now\(\) >= deadline/);
});

test("session fakes without clickAt keep the legacy in-page click", () => {
  assert.match(source, /if \(!this\.session\.clickAt\)/);
  assert.match(source, /el\.click\(\);/);
});

test("both click paths still route through the guarded dispatch", () => {
  const irreversible = source.indexOf("async clickIrreversible");
  const plain = source.indexOf("async click(");
  assert.ok(irreversible > 0 && plain > 0);
  assert.match(source.slice(irreversible, irreversible + 400), /dispatchClick/);
  assert.match(source.slice(plain, plain + 700), /dispatchClick/);
});

test("candidate selection prefers the element that wins the hit-test", () => {
  // Instagram renders stacked accessibility twins; the first style-visible match can sit under
  // the strip that actually receives clicks. Run 10 refused exactly that: the located Weiter was
  // occluded by the header strip containing the real control.
  assert.match(source, /const hitTestable = \(el\)/);
  assert.match(source, /visible\.find\(\(el\) => hitTestable\(el\)\)/);
});

test("hit-test preference keeps a style-visible fallback and never applies to hidden targets", () => {
  // SET_FILE targets are legitimately invisible; the preference is scoped to visibleOnly.
  assert.match(source, /if \(visible\.length > 0\) return pick\(visible\[0\]/);
});

test("a persistently occluded reversible click may fall back to the rendered label", () => {
  // Instagram paints the visible Weiter as a bare text node inside a strip that owns pointer
  // events, while the accessible control is a stacked twin. A person clicks where the word is.
  assert.match(source, /allowLabelFallback && probe\.occludedBy !== null/);
  assert.match(source, /createTreeWalker\(hit, NodeFilter\.SHOW_TEXT\)/);
});

test("the label fallback exists for click() and never for clickIrreversible()", () => {
  const irreversible = source.indexOf("async clickIrreversible");
  const plain = source.indexOf("async click(");
  const irreversibleBlock = source.slice(irreversible, source.indexOf("async click(", irreversible));
  assert.match(source, /dispatchClick\(target\.token, target\.descriptor, "Target disappeared before click", true\)/);
  // The irreversible dispatch line itself carries no fallback flag.
  assert.match(irreversibleBlock, /dispatchClick\(target\.token, target\.descriptor, "Final-action target disappeared before click"\)/);
  assert.doesNotMatch(irreversibleBlock, /dispatchClick\([^)]*true\)/);
});

test("the fallback clicks only an exact text match of the located label", () => {
  assert.match(source, /text !== /);
  assert.match(source, /range\.selectNodeContents\(node\)/);
});
