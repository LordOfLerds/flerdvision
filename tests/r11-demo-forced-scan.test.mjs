import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The acceptance run stalled at "has no READY source asset", which reads like an empty Drive
// folder. It was not: the source poll runs on an interval, the second demo fell inside it, the
// scan was skipped and returned zeros -- and the run still printed
// "INGEST_PLAN PASS · source scanned and deterministic plan persisted".

const source = readFileSync(new URL("../src/application/headless-demo.ts", import.meta.url).pathname, "utf8");

test("an operator-initiated demo forces the scan instead of obeying the poll interval", () => {
  assert.match(source, /forceScan\(startedAt, "MANUAL"\)/);
  // runCycle's gated scan may still run for planning, but it must not be the only observation.
  assert.match(source, /interval-gated poll/);
});

test("first-touch media gets the second observation readiness requires", () => {
  // Readiness needs two observations of identical bytes, so one scan can never produce READY.
  assert.match(source, /scan\.ready === 0 && scan\.stabilizing > 0/);
  assert.match(source, /stabilizeSettleMs \?\? 5_000/);
});

test("the settle is configurable so a slow cloud sync can be given more room", () => {
  assert.match(source, /stabilizeSettleMs\?: number/);
});

test("the ingest summary reports what was actually observed, not a fixed sentence", () => {
  assert.doesNotMatch(source, /INGEST_PLAN PASS · source scanned and deterministic plan persisted/);
  assert.match(source, /forced scan\(s\) · observed=/);
  assert.match(source, /ready=\$\{scan\.ready\} stabilizing=\$\{scan\.stabilizing\} blocked=\$\{scan\.blocked\}/);
});

test("a run with no READY asset fails with the reason instead of an empty-folder-sounding message", () => {
  assert.match(source, /No source asset reached READY after \$\{scans\} scan\(s\)/);
  assert.match(source, /two observations of identical bytes plus a readable media probe/);
  // The safety rule itself is preserved and stated, not bypassed.
  assert.match(source, /still-uploading or unreadable file stays out of the publish path/);
});

test("readiness is not weakened: the demo never marks an asset READY itself", () => {
  assert.doesNotMatch(source, /putAsset/);
  assert.doesNotMatch(source, /"READY"/);
});
