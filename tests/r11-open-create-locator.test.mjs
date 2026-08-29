import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Surface discovery stopped at "No safe locator found for OPEN_CREATE" on a healthy, logged-in
// account. The control was present the whole time: Instagram renders its create entry as one
// link containing two text nodes, so the accessible name resolves to the concatenation
// "Neuer BeitragErstellen" and every exact match against "Erstellen" or "Neuer Beitrag" missed.

const source = readFileSync(new URL("../src/adapters/browser/autonomous-surface-explorer.ts", import.meta.url).pathname, "utf8");

/** Mirrors dom-ui-driver's matching so the test pins the real rule, not a paraphrase. */
function matches(actual, expected, exact) {
  const normalize = (value) => value.replace(/\s+/g, " ").trim().toLocaleLowerCase("en-US");
  return exact ? normalize(actual) === normalize(expected) : normalize(actual).includes(normalize(expected));
}

const REAL_CREATE_NAME = "Neuer BeitragErstellen";

test("the observed accessible name defeats every exact candidate", () => {
  for (const label of ["Erstellen", "Create", "Neuer Beitrag", "New post"]) {
    assert.equal(matches(REAL_CREATE_NAME, label, true), false, `${label} must not match exactly`);
  }
});

test("a substring candidate does match it", () => {
  assert.equal(matches(REAL_CREATE_NAME, "Erstellen", false), true);
  assert.equal(matches(REAL_CREATE_NAME, "Create", false), false, "German UI: Create is genuinely absent");
});

test("the explorer offers substring fallbacks for the create step", () => {
  assert.match(source, /function namedContains/);
  assert.match(source, /namedContains\("link", \["Erstellen", "Create"\]\)/);
});

test("substring candidates come after the exact ones so precision is tried first", () => {
  const line = source.split("\n").find((l) => l.includes('stepKey: "OPEN_CREATE"'));
  assert.ok(line, "OPEN_CREATE step must exist");
  assert.ok(line.indexOf('named("button"') < line.indexOf("namedContains("), "exact candidates must be listed first");
});

test("the format-selection step gets the same treatment", () => {
  const line = source.split("\n").find((l) => l.includes("SELECT_REEL"));
  assert.match(line, /namedContains\("button", formatNames\)/);
  assert.ok(line.indexOf('named("button", formatNames)') < line.indexOf("namedContains("));
});

test("the final action is not given substring fallbacks", () => {
  // Loosening matching around the irreversible boundary is exactly what must not happen.
  const finalLines = source.split("\n").filter((l) => l.includes("FINAL_ACTION"));
  for (const line of finalLines) assert.doesNotMatch(line, /namedContains/);
});

test("format selection never targets the Reels feed navigation", () => {
  // The create menu offers "Beitrag" only; "Reels" is the nav feed item, and clicking it closes
  // the menu and navigates away. That collision burned a real qualification run.
  const line = source.split("\n").find((l) => l.includes("const formatNames"));
  assert.ok(line, "formatNames must exist");
  assert.doesNotMatch(line, /"Reels"/);
  assert.doesNotMatch(line, /"Reel"/);
  assert.match(line, /"Beitrag"/);
});
