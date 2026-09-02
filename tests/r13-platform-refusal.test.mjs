import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { detectPlatformRefusal, PlatformRefusedError, PLATFORM_REFUSAL_MARKERS } from "../dist/adapters/browser/platform-refusal.js";

// A fresh YouTube channel hit "Tägliches Upload-Limit erreicht" after two dozen uploads. Studio
// then greyed the details form, and the run reported an occluded title field and retried --
// forever, because nothing read the sentence the platform had painted on the page. A refusal is
// an account state: it stops the run, names itself, and is never treated as UI drift.

function sessionShowing(sentence) {
  return {
    async evaluate(expression) {
      // The probe collects visible leaf texts; the fake answers with the one on screen.
      if (!expression.includes("PLATFORM_REFUSAL") && !expression.includes("markers")) return null;
      const markers = JSON.parse(expression.slice(expression.indexOf("["), expression.indexOf("]") + 1));
      const marker = markers.find((candidate) => sentence.toLocaleLowerCase("en-US").includes(candidate));
      return marker ? { marker, sentence } : null;
    }
  };
}

test("the daily upload limit is reported as a platform refusal, not as a locator problem", async () => {
  const refusal = await detectPlatformRefusal(sessionShowing("Tägliches Upload-Limit erreicht"));
  assert.ok(refusal instanceof PlatformRefusedError);
  assert.match(refusal.message, /Tägliches Upload-Limit erreicht/);
  assert.match(refusal.message, /no retry will fix it/);
});

test("a healthy page yields no refusal", async () => {
  assert.equal(await detectPlatformRefusal(sessionShowing("Details")), null);
});

test("blocks, rate limits and suspensions are all covered in both languages", () => {
  for (const expected of ["daily upload limit reached", "aktion blockiert", "action blocked", "your account has been suspended"]) {
    assert.ok(PLATFORM_REFUSAL_MARKERS.includes(expected), `missing marker: ${expected}`);
  }
});

test("a refusal never crashes the probe when the page cannot be read", async () => {
  const broken = { async evaluate() { throw new Error("detached"); } };
  assert.equal(await detectPlatformRefusal(broken), null);
});

test("every explorer step passes through the refusal check and captures evidence", () => {
  const source = readFileSync(new URL("../src/adapters/browser/autonomous-surface-explorer.ts", import.meta.url).pathname, "utf8");
  const idx = source.indexOf("private async executeStep(");
  const block = source.slice(idx, idx + 1400);
  assert.match(block, /return await this\.runStep\(/);
  assert.match(block, /detectPlatformRefusal\(this\.session\)/);
  assert.match(block, /autonomous-platform-refused/);
  // A refusal already recognised must not be re-probed into something vaguer.
  assert.match(block, /if \(error instanceof PlatformRefusedError\) throw error;/);
});

test("an occlusion names the element instead of an anonymous div", () => {
  const source = readFileSync(new URL("../src/adapters/browser/dom-ui-driver.ts", import.meta.url).pathname, "utf8");
  const idx = source.indexOf("const describe = (node)");
  const block = source.slice(idx, idx + 1200);
  assert.match(block, /node\.id \? '#' \+ node\.id/);
  assert.match(block, /getAttribute\('class'\)/);
  assert.match(block, /getComputedStyle\(node\)\.zIndex/);
  assert.match(source, /target was \$\{probe\.target\}/);
});
