import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The daemon crash-looped all evening: one unqualified route (a Trial-Reel route waiting for
// Instagram's switch) threw at startup and launchd restarted it every minute, so the two
// qualified routes never posted. An unqualified route is skipped with one line; only an account
// without any qualified route is a startup error.
test("an unqualified route is skipped, not fatal; an account without any qualified route is", () => {
  const src = readFileSync(new URL("../src/application/headless-autonomous-runtime.ts", import.meta.url).pathname, "utf8");
  assert.match(src, /wird übersprungen — nicht freigegeben/);
  assert.match(src, /if \(unqualified\.length === routes\.length\) throw new Error\(`Autonomous account \$\{accountId\} has no qualified route/);
  assert.doesNotMatch(src, /throw new Error\(`Route \$\{route\.routeId\} is not autonomous-surface-qualified/);
});

test("per-slot readiness warnings only reach the operator for routes that are operating", () => {
  const planner = readFileSync(new URL("../src/application/readiness-notification-planner.ts", import.meta.url).pathname, "utf8");
  assert.match(planner, /const operating = new Set<string>\(input\.plan\.deliveries\.map\(\(item\) => item\.routeId\)\);/);
  assert.match(planner, /if \(!operating\.has\(route\.routeId\)\) continue;/);
  const messages = readFileSync(new URL("../src/application/operator-message.ts", import.meta.url).pathname, "utf8");
  assert.match(messages, /PRE_SLOT_ESCALATION: \{ meaning: "Ein Slot ist gleich fällig und noch ohne Video"/);
});
