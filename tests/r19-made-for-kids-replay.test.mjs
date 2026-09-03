import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tagMadeForKidsOption, readMadeForKids } from "../dist/adapters/browser/made-for-kids.js";

// A replay opens a fresh Studio. The made-for-kids answer there cannot be found by the exact
// contract wording -- Studio splits and decorates it -- so the replay answers by meaning, with
// the same discriminator the exploration used, instead of trusting a recorded string.

const src = (rel) => readFileSync(new URL(rel, import.meta.url).pathname, "utf8");

test("the plan turns the AUDIENCE step into an ANSWER_AUDIENCE action carrying the declaration", () => {
  const plan = src("../src/application/platform-execution-plan.ts");
  assert.match(plan, /step\.stepKey==="AUDIENCE"/);
  assert.match(plan, /operation:"ANSWER_AUDIENCE",locators:locators\(step\),settingKey:"madeForKids",expectedValue:p\.madeForKids/);
  assert.match(src("../src/domain/platform-execution.ts"), /"ANSWER_AUDIENCE"/);
});

test("the runner answers by meaning and proves the radio took the answer", () => {
  const runner = src("../src/adapters/browser/platform-execution-runner.ts");
  assert.match(runner, /action\.operation==="ANSWER_AUDIENCE"/);
  assert.match(runner, /tagMadeForKidsOption\(this\.session,madeForKids\)/);
  assert.match(runner, /Made-for-kids declaration did not take/);
});

test("the helpers fail closed on a page without the options", async () => {
  const empty = { async evaluate() { return false; } };
  assert.equal(await tagMadeForKidsOption(empty, false), false);
  assert.equal(await readMadeForKids(empty, false), false);
  const broken = { async evaluate() { throw new Error("detached"); } };
  assert.equal(await tagMadeForKidsOption(broken, false), false);
});

test("the discriminator tells the two answers apart by 'nicht'/'not' only", async () => {
  const captured = [];
  const session = { async evaluate(expr) { captured.push(expr); return true; } };
  await tagMadeForKidsOption(session, false);
  assert.match(captured[0], /const negative = true;/);
  assert.match(captured[0], /text\.includes\("nicht"\) \|\| text\.startsWith\("no,"\) \|\| text\.includes\("not made"\)/);
});

test("an already-answered question, shown only as Studio's summary sentence, counts as in force", async () => {
  const captured = [];
  const session = { async evaluate(expr) { captured.push(expr); return true; } };
  assert.equal(await readMadeForKids(session, false), true);
  assert.match(captured[0], /speziell für kinder"\) && text\.includes\("festgelegt"\)/);
  assert.match(captured[0], /text\.includes\("nicht als"\)/);
});

test("a contract never records the same step key twice", () => {
  const q = readFileSync(new URL("../src/application/autonomous-surface-qualification.ts", import.meta.url).pathname, "utf8");
  assert.match(q, /const dedupedSteps = settings\.contract\.steps\.filter\(\(step\) => \{ if \(seenKeys\.has\(step\.stepKey\)\) return false; seenKeys\.add\(step\.stepKey\); return true; \}\);/);
  assert.match(q, /recordContract\(\{ \.\.\.settings\.contract, steps: dedupedSteps \}/);
});
