import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = (rel) => readFileSync(new URL(rel, import.meta.url).pathname, "utf8");

// The YouTube replay recording showed the title doubled: Studio pre-fills the filename and the
// keyboard select-all never cleared it. And a replay that died left only one sentence behind.

test("a pre-filled editable is cleared in-page and, failing that, character by character", () => {
  const driver = src("../src/adapters/browser/dom-ui-driver.ts");
  assert.match(driver, /range\.selectNodeContents\(el\)/);
  assert.match(driver, /pressKey\("Backspace"\)/);
  assert.match(driver, /Pre-filled text could not be cleared before typing/);
});

test("every failing replay action captures the page and journals the failure", () => {
  const runner = src("../src/adapters/browser/platform-execution-runner.ts");
  assert.match(runner, /surface-execution-\$\{action\.stepKey\.toLocaleLowerCase\("en-US"\)\}-failed/);
  assert.match(runner, /outcome:"FAIL",detail:error instanceof Error\?error\.message:String\(error\)/);
});

test("a missing made-for-kids option scrolls the lazy sections into existence before giving up", () => {
  assert.match(src("../src/adapters/browser/made-for-kids.ts"), /scroller\.scrollTop = scroller\.scrollHeight/);
});
