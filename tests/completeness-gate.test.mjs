import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const matrix = JSON.parse(readFileSync(new URL("../architecture/completeness-matrix.json", import.meta.url), "utf8"));
const repairGraph = JSON.parse(readFileSync(new URL("../architecture/repair-graph.json", import.meta.url), "utf8"));

const greenWords = new Set(["GREEN", "DONE", "COMPLETE", "COMPLETED", "READY"]);

test("completion matrix never marks a stage green without durable claim evidence", () => {
  for (const stage of matrix.stages) {
    if (stage.green) {
      assert.fail(`${stage.id} is marked green but this audit has no durable per-stage evidence bundle proving it`);
    }
    assert.ok(Array.isArray(stage.open), `${stage.id} must enumerate open items`);
  }
});

test("repair graph cannot claim DONE/GREEN/COMPLETE while completion matrix says not green", () => {
  const byId = new Map(matrix.stages.map((stage) => [stage.id, stage]));
  for (const stage of repairGraph.stages ?? []) {
    if (!greenWords.has(String(stage.status).toUpperCase())) continue;
    const evidence = byId.get(stage.id);
    assert.ok(evidence, `repair graph stage ${stage.id} has a completion claim but no completion-matrix entry`);
    assert.equal(evidence.green, true, `${stage.id} is ${stage.status} in repair graph without completion evidence`);
  }
});

test("project-level production gates remain false until real-host evidence exists", () => {
  const audit = matrix.currentAudit;
  assert.equal(audit.freshCloneFullSuiteVerified, false);
  assert.equal(audit.allRepairChangesIntegratedIntoExistingEntrypoints, false);
  assert.equal(audit.realSocialSurfaceTested, false);
  assert.equal(audit.lucaMacPassed, false);
  assert.equal(audit.fabianMacPassed, false);
  assert.equal(audit.vpsStagingPassed, false);
  assert.equal(audit.customerCanaryPassed, false);
});
