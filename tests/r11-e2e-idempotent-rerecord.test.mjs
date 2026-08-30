import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SqliteControlPlaneStore } from "../dist/adapters/storage/sqlite.js";

// Live acceptance failure: the very first real private-E2E run died on
// "E2E gate e2e-gate:... conflicts" while re-recording a CONTENT-IDENTICAL gate.
// syncEvidence legitimately runs several times per run (demo, prepare, invokeFinal); the
// idempotency comparison used key-order-sensitive JSON.stringify over objects built in
// different key orders, and details was undefined on one side and null on the other.
// Run identity had the deeper variant: it compared mutable fields (status, note, createdAt),
// so resuming the same deterministic run id would always conflict.

const actor = { type: "system", id: "test" };

function storeWithRun() {
  const store = new SqliteControlPlaneStore(":memory:");
  store.registerSocialAccount({ accountId: "acct", platform: "instagram", expectedHandle: "acct", enabled: true }, "2026-08-29T20:00:00Z", actor);
  const run = {
    runId: "private-e2e|intent|sha", accountId: "acct", platform: "instagram", releaseSha: "sha",
    createdAt: "2026-08-29T21:00:00.000Z", createdBy: "op", status: "ACTIVE",
    testMediaOnly: true, zeroViewerRequired: true, note: "first"
  };
  store.createOrGetE2ERun(run, actor);
  return { store, run };
}

test("re-entering the same run with fresh note/createdAt resumes instead of conflicting", () => {
  const { store, run } = storeWithRun();
  const resumed = store.createOrGetE2ERun({ ...run, createdAt: "2026-08-29T22:00:00.000Z", note: "second attempt" }, actor);
  assert.equal(resumed.runId, run.runId);
  assert.equal(resumed.note, "first");
});

test("a run with a different release identity still conflicts", () => {
  const { store, run } = storeWithRun();
  assert.throws(() => store.createOrGetE2ERun({ ...run, releaseSha: "other" }, actor), /conflicts/);
});

test("re-recording a content-identical gate without details is idempotent", () => {
  const { store } = storeWithRun();
  const gate = {
    gateResultId: "e2e-gate:g1", runId: "private-e2e|intent|sha", gate: "SESSION_HEALTH",
    status: "PASS", checkedAt: "2026-08-29T21:01:07.887Z", checkedBy: "op",
    summary: "session healthy", artifactRefs: []
  };
  store.recordE2EGateResult(gate, actor);
  const second = store.recordE2EGateResult({ ...gate }, actor);
  assert.equal(second.gateResultId, "e2e-gate:g1");
});

test("a gate with genuinely different content still conflicts", () => {
  const { store } = storeWithRun();
  const gate = {
    gateResultId: "e2e-gate:g2", runId: "private-e2e|intent|sha", gate: "SESSION_HEALTH",
    status: "PASS", checkedAt: "2026-08-29T21:01:07.887Z", checkedBy: "op",
    summary: "session healthy", artifactRefs: []
  };
  store.recordE2EGateResult(gate, actor);
  assert.throws(() => store.recordE2EGateResult({ ...gate, status: "FAIL" }, actor), /conflicts/);
  assert.throws(() => store.recordE2EGateResult({ ...gate, artifactRefs: ["x"] }, actor), /conflicts/);
});

test("details recorded as an object round-trips into the identity comparison", () => {
  const { store } = storeWithRun();
  const gate = {
    gateResultId: "e2e-gate:g3", runId: "private-e2e|intent|sha", gate: "PRIVACY_ATTESTATION",
    status: "PASS", checkedAt: "2026-08-29T21:02:00.000Z", checkedBy: "op",
    summary: "attested", artifactRefs: [], details: { approvedFollowers: 0 }
  };
  store.recordE2EGateResult(gate, actor);
  const second = store.recordE2EGateResult({ ...gate, details: { approvedFollowers: 0 } }, actor);
  assert.equal(second.gateResultId, "e2e-gate:g3");
  assert.throws(() => store.recordE2EGateResult({ ...gate, details: { approvedFollowers: 1 } }, actor), /conflicts/);
});

test("the CLI prints the full error cause chain, not only the top message", () => {
  const cli = readFileSync(new URL("../src/cli/flerdvision.ts", import.meta.url).pathname, "utf8");
  const idx = cli.indexOf("main().catch");
  const block = cli.slice(idx);
  assert.match(block, /caused by/);
  assert.match(block, /\.cause/);
});
