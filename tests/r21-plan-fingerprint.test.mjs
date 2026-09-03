import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// A caption template edited mid-day changed the provenance snapshot but not the plan id, and
// every later planning of that day was refused as "already has different provenance".
test("the daily plan id covers the resolved copy and posting profiles", () => {
  const planner = readFileSync(new URL("../src/application/distribution-planner.ts", import.meta.url).pathname, "utf8");
  const idx = planner.indexOf("const configFingerprint = sha(");
  const block = planner.slice(idx, idx + 600);
  assert.match(block, /copyProfiles: input\.routes\.map\(\(route\) => input\.catalog\.copyProfiles\[route\.copyProfileId\]/);
  assert.match(block, /postingProfiles: input\.routes\.map\(\(route\) => input\.catalog\.postingProfiles\[route\.postingProfileId\]/);
});
