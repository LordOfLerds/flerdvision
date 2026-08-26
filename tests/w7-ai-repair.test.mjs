import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { SqliteControlPlaneStore } from "../dist/adapters/storage/sqlite.js";
import { IncidentEvidenceBundleBuilder, IncidentTextRedactor, SafeLocalArtifactTextReader } from "../dist/adapters/repair/redaction.js";
import { CommandAiDiagnosisAdapter } from "../dist/adapters/repair/command-ai.js";
import { GitRepairWorkspace } from "../dist/adapters/repair/git-workspace.js";
import { AiRepairService, RepairPatchValidationError, RepairPatchValidator, RepairPolicy, extractChangedFiles } from "../dist/application/ai-repair.js";

const actor = { type: "test", id: "w7" };

function createIncident(store, overrides = {}) {
  return store.createOrRefreshIncident({
    fingerprint: overrides.fingerprint ?? `UI_UNKNOWN:${Math.random()}`,
    kind: overrides.kind ?? "UI_UNKNOWN",
    severity: overrides.severity ?? "ERROR",
    title: overrides.title ?? "Composer changed",
    summary: overrides.summary ?? "Expected create flow element is missing",
    observedAt: overrides.observedAt ?? "2026-08-26T18:00:00Z",
    scope: overrides.scope ?? { accountId: "acct:test", platform: "instagram" },
    evidenceRefs: overrides.evidenceRefs ?? [],
    metadata: overrides.metadata ?? {}
  }, actor).incident;
}

function diagnosis(overrides = {}) {
  return {
    diagnosisId: "diagnosis:test", bundleId: "bundle:test", incidentId: "incident:test", createdAt: "2026-08-26T18:01:00Z",
    classification: "SELECTOR_DRIFT", confidence: 0.94, rootCause: "accessible button label changed",
    evidenceRationale: ["DOM contains replacement button"], proposedRepairKind: "SELECTOR_CONFIG_CHANGE",
    requiresHuman: false, securityNotes: [], ...overrides
  };
}

test("migration 7 creates immutable AI-repair audit tables", () => {
  const dir = mkdtempSync(join(tmpdir(), "flerdvision-w7-db-"));
  const path = join(dir, "db.sqlite");
  const store = new SqliteControlPlaneStore(path);
  try {
    const versions = new DatabaseSync(path).prepare("SELECT version FROM schema_migrations ORDER BY version").all().map((x) => Number(x.version));
    assert.deepEqual(versions.slice(0, 7), [1,2,3,4,5,6,7]);
  } finally { store.close(); }
  const raw = new DatabaseSync(path);
  try {
    for (const table of ["incident_evidence_bundles", "ai_diagnoses", "repair_proposals", "repair_gate_results", "repair_branches"]) {
      assert.equal(raw.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name=?").get(table).c, 1);
    }
  } finally { raw.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("incident evidence bundle redacts secrets and excludes binary screenshots from AI input", () => {
  const dir = mkdtempSync(join(tmpdir(), "flerdvision-w7-evidence-"));
  const log = join(dir, "page.log");
  const png = join(dir, "screen.png");
  writeFileSync(log, `Authorization: Bearer SUPERSECRET\nCookie: session=COOKIEVALUE\nemail=user@example.com\npassword=hunter2\nurl=https://example.test/?token=qwerty\n`, { mode: 0o600 });
  writeFileSync(png, "not-really-png", { mode: 0o600 });
  const store = new SqliteControlPlaneStore(":memory:");
  try {
    const incident = createIncident(store, {
      evidenceRefs: [log, png],
      summary: "failure for user@example.com password=secret123",
      metadata: { authorization: "Bearer FROM_META", phone: "+43 660 1234567" }
    });
    const bundle = new IncidentEvidenceBundleBuilder(store, new SafeLocalArtifactTextReader(dir)).build(incident, { capturedAt: "2026-08-26T18:02:00Z", releaseSha: "abc123", adapterVersion: "instagram-web:v1" });
    const serialized = JSON.stringify(bundle);
    for (const forbidden of ["SUPERSECRET", "COOKIEVALUE", "hunter2", "qwerty", "user@example.com", "secret123", "FROM_META", "+43 660 1234567"]) assert.equal(serialized.includes(forbidden), false, forbidden);
    assert.ok(bundle.redactionFindings.length >= 3);
    assert.equal(bundle.artifacts.find((x) => x.mediaType === "image/png").disposition, "OMITTED_BINARY");
    assert.equal(bundle.artifacts.find((x) => x.mediaType === "text/plain").disposition, "INCLUDED_TEXT");
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("artifact reader refuses paths outside configured evidence root", () => {
  const dir = mkdtempSync(join(tmpdir(), "flerdvision-w7-root-"));
  const outsideDir = mkdtempSync(join(tmpdir(), "flerdvision-w7-outside-"));
  const outside = join(outsideDir, "secret.log");
  writeFileSync(outside, "token=DO_NOT_READ", { mode: 0o600 });
  try {
    const result = new SafeLocalArtifactTextReader(dir).inspect(outside);
    assert.equal(result.disposition, "OMITTED_UNSAFE");
    assert.equal(JSON.stringify(result).includes("DO_NOT_READ"), false);
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(outsideDir, { recursive: true, force: true }); }
});

test("redactor removes sensitive HTML field values and home paths", () => {
  const result = new IncidentTextRedactor().redact(`<input type="password" value="abc123"><input type="email" value="a@b.com"> /home/alice/runtime/session.json`);
  assert.equal(result.text.includes("abc123"), false);
  assert.equal(result.text.includes("a@b.com"), false);
  assert.equal(result.text.includes("/home/alice"), false);
});

test("repair policy prohibits uncertain publish and human-only account/policy incidents", () => {
  const policy = new RepairPolicy();
  assert.equal(policy.evaluate("PUBLISH_UNCERTAIN", diagnosis({ classification: "PUBLISH_OUTCOME_UNCERTAIN" })).decision, "PROHIBITED");
  assert.equal(policy.evaluate("AUTH_REQUIRED", diagnosis({ classification: "AUTHENTICATION_REQUIRED", proposedRepairKind: "NO_AUTOMATED_REPAIR", requiresHuman: true })).decision, "HUMAN_ONLY");
  assert.equal(policy.evaluate("COPYRIGHT_WARNING", diagnosis({ classification: "POLICY_OR_COPYRIGHT", requiresHuman: true })).decision, "HUMAN_ONLY");
  assert.equal(policy.evaluate("UI_UNKNOWN", diagnosis()).decision, "AUTO_CANDIDATE");
});

test("patch validator denies safety/final-action changes and requires a regression test", () => {
  const validator = new RepairPatchValidator();
  const verdict = new RepairPolicy().evaluate("UI_UNKNOWN", diagnosis());
  const base = { proposalId: "p", diagnosisId: "d", incidentId: "i", createdAt: "2026-08-26T18:00:00Z", title: "x", summary: "x", requestedTestCommands: [] };
  assert.throws(() => validator.validate({ ...base, unifiedDiff: "x", changedFiles: ["src/domain/safety.ts"], regressionTestFiles: ["tests/w7-x.test.mjs"] }, verdict), RepairPatchValidationError);
  assert.throws(() => validator.validate({ ...base, unifiedDiff: "x", changedFiles: ["config/platform-ui.test.json"], regressionTestFiles: [] }, verdict), /regression test/);
  assert.throws(() => validator.validate({ ...base, unifiedDiff: "+ allowFinalPublish", changedFiles: ["config/platform-ui.test.json", "tests/w7-x.test.mjs"], regressionTestFiles: ["tests/w7-x.test.mjs"] }, verdict), /protected token/);
  assert.throws(() => validator.validate({ ...base, unifiedDiff: "deleted file mode 100644", changedFiles: ["config/platform-ui.test.json", "tests/w7-x.test.mjs"], regressionTestFiles: ["tests/w7-x.test.mjs"] }, verdict), /may not delete/);
});

test("command AI adapter receives sanitized payload but not inherited social secrets", async () => {
  const dir = mkdtempSync(join(tmpdir(), "flerdvision-w7-ai-"));
  const script = join(dir, "ai.mjs");
  writeFileSync(script, `let s=''; for await (const c of process.stdin) s+=c; const p=JSON.parse(s); process.stdout.write(JSON.stringify({classification:'SELECTOR_DRIFT',confidence:0.9,rootCause:'label changed',evidenceRationale:[p.contract],proposedRepairKind:'SELECTOR_CONFIG_CHANGE',requiresHuman:false,securityNotes:['social_secret='+String(process.env.SOCIAL_PASSWORD||'ABSENT')]}));`);
  const previous = process.env.SOCIAL_PASSWORD;
  process.env.SOCIAL_PASSWORD = "MUST_NOT_LEAK";
  try {
    const adapter = new CommandAiDiagnosisAdapter({ command: process.execPath, args: [script] });
    const result = await adapter.diagnose({ bundleId: "b", incidentId: "i", capturedAt: "2026-08-26T18:00:00Z", releaseSha: "x", adapterVersion: "x", redactionPolicyVersion: "v", incidentKind: "UI_UNKNOWN", incidentSummary: "x", sanitizedContext: {}, artifacts: [], redactionFindings: [] });
    assert.deepEqual(result.securityNotes, ["social_secret=ABSENT"]);
  } finally { if (previous === undefined) delete process.env.SOCIAL_PASSWORD; else process.env.SOCIAL_PASSWORD = previous; rmSync(dir, { recursive: true, force: true }); }
});

test("untrusted AI schema output is rejected before repair policy or patching", async () => {
  const evidenceRoot = mkdtempSync(join(tmpdir(), "flerdvision-w7-invalid-ai-"));
  const store = new SqliteControlPlaneStore(":memory:");
  try {
    const incident = createIncident(store);
    const badDiagnosis = { async diagnose() { return { classification: "DO_WHATEVER", confidence: 99, rootCause: "x", evidenceRationale: [], proposedRepairKind: "CODE_CHANGE", requiresHuman: false, securityNotes: [] }; } };
    const proposal = { async propose() { throw new Error("must not be reached"); } };
    const workspace = { createBranch() { throw new Error("must not branch"); }, runCommand() { throw new Error("must not run"); }, changedFiles() { return []; }, headSha() { return undefined; } };
    const service = new AiRepairService(store, store, new IncidentEvidenceBundleBuilder(store, new SafeLocalArtifactTextReader(evidenceRoot)), badDiagnosis, proposal, workspace);
    await assert.rejects(() => service.diagnoseIncident(incident.incidentId, { now: "2026-08-26T18:05:00Z", releaseSha: "x", adapterVersion: "x" }, actor), /invalid classification/);
    assert.equal(store.listAiDiagnoses(incident.incidentId).length, 0);
  } finally { store.close(); rmSync(evidenceRoot, { recursive: true, force: true }); }
});

test("AI command adapter rejects arbitrary environment injection", async () => {
  const adapter = new CommandAiDiagnosisAdapter({ command: process.execPath, args: ["-e", "process.stdout.write('{}')"], env: { INSTAGRAM_PASSWORD: "nope" } });
  await assert.rejects(() => adapter.diagnose({ bundleId: "b", incidentId: "i", capturedAt: "2026-08-26T18:00:00Z", releaseSha: "x", adapterVersion: "x", redactionPolicyVersion: "v", incidentKind: "UI_UNKNOWN", incidentSummary: "x", sanitizedContext: {}, artifacts: [], redactionFindings: [] }), /not allowlisted/);
});

function initRepairRepo() {
  const dir = mkdtempSync(join(tmpdir(), "flerdvision-w7-git-"));
  mkdirSync(join(dir, "config"), { recursive: true }); mkdirSync(join(dir, "tests"), { recursive: true });
  writeFileSync(join(dir, "config/platform-ui.test.json"), '{"button":"Old"}\n');
  writeFileSync(join(dir, "tests/w7-generated.test.mjs"), 'export const label = "Old";\n');
  spawnSync("git", ["init"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "test@example.invalid"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "W7 Test"], { cwd: dir });
  spawnSync("git", ["add", "."], { cwd: dir }); spawnSync("git", ["commit", "-m", "base"], { cwd: dir });
  const baseRef = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).stdout.trim();
  writeFileSync(join(dir, "config/platform-ui.test.json"), '{"button":"New"}\n');
  writeFileSync(join(dir, "tests/w7-generated.test.mjs"), 'export const label = "New";\n');
  const diff = spawnSync("git", ["diff", "--", "config/platform-ui.test.json", "tests/w7-generated.test.mjs"], { cwd: dir, encoding: "utf8" }).stdout;
  spawnSync("git", ["restore", "."], { cwd: dir });
  return { dir, baseRef, diff };
}

test("git repair workspace creates isolated branch, applies only the patch, and exposes changed files", () => {
  const repo = initRepairRepo();
  const worktreeRoot = mkdtempSync(join(tmpdir(), "flerdvision-w7-worktrees-"));
  try {
    const workspace = new GitRepairWorkspace({ repositoryPath: repo.dir, worktreeRoot });
    const branch = workspace.createBranch({ proposalId: "proposal:test", branchName: "repair/test-one", baseRef: repo.baseRef, unifiedDiff: repo.diff, createdAt: "2026-08-26T18:00:00Z" });
    assert.deepEqual(workspace.changedFiles(branch), ["config/platform-ui.test.json", "tests/w7-generated.test.mjs"]);
    assert.equal(readFileSync(join(repo.dir, "config/platform-ui.test.json"), "utf8"), '{"button":"Old"}\n', "main worktree must remain untouched");
    assert.equal(readFileSync(join(branch.worktreePath, "config/platform-ui.test.json"), "utf8"), '{"button":"New"}\n');
  } finally { rmSync(worktreeRoot, { recursive: true, force: true }); rmSync(repo.dir, { recursive: true, force: true }); }
});

test("AI repair service can diagnose, policy-gate, branch and run regression/full tests without production promotion", async () => {
  const repo = initRepairRepo();
  const worktreeRoot = mkdtempSync(join(tmpdir(), "flerdvision-w7-service-worktrees-"));
  const evidenceRoot = mkdtempSync(join(tmpdir(), "flerdvision-w7-service-evidence-"));
  const store = new SqliteControlPlaneStore(":memory:");
  try {
    const incident = createIncident(store);
    const diagnosisPort = { async diagnose() { return { classification: "SELECTOR_DRIFT", confidence: 0.95, rootCause: "label changed", evidenceRationale: ["fixture"], proposedRepairKind: "SELECTOR_CONFIG_CHANGE", requiresHuman: false, securityNotes: [] }; } };
    const proposalPort = { async propose() { return { title: "Update selector", summary: "Use new label", unifiedDiff: repo.diff, regressionTestFiles: ["tests/w7-generated.test.mjs"], requestedTestCommands: ["rm -rf / --this-is-advisory-and-must-never-run"] }; } };
    const workspace = new GitRepairWorkspace({ repositoryPath: repo.dir, worktreeRoot });
    const replay = { async replay() { return { passed: true, summary: "synthetic prepare-only replay passed", artifactRefs: ["artifact:synthetic"] }; } };
    const service = new AiRepairService(store, store, new IncidentEvidenceBundleBuilder(store, new SafeLocalArtifactTextReader(evidenceRoot)), diagnosisPort, proposalPort, workspace, replay, undefined, undefined, {
      regressionCommand: [process.execPath, "-e", "process.exit(0)"],
      fullSuiteCommand: [process.execPath, "-e", "process.exit(0)"]
    });
    const report = await service.prepareRepair(incident.incidentId, { now: "2026-08-26T18:10:00Z", releaseSha: repo.baseRef, adapterVersion: "synthetic:v1", baseRef: repo.baseRef }, actor);
    assert.equal(report.verdict.decision, "AUTO_CANDIDATE");
    assert.equal(report.readyForHumanReview, true);
    assert.equal(report.productionPromotionAllowed, false);
    assert.deepEqual(report.gates.map((x) => [x.gate, x.status]), [["POLICY","PASS"],["PATCH_SCOPE","PASS"],["REGRESSION","PASS"],["FULL_SUITE","PASS"],["PREPARE_ONLY","PASS"]]);
    assert.equal(store.listEvidenceBundles(incident.incidentId).length, 1);
    assert.equal(store.listAiDiagnoses(incident.incidentId).length, 1);
    assert.equal(store.listRepairProposals(incident.incidentId).length, 1);
    assert.equal(store.listRepairGateResults(report.proposal.proposalId).length, 5);
    assert.ok(store.getRepairBranch(report.proposal.proposalId));
  } finally { store.close(); rmSync(worktreeRoot, { recursive: true, force: true }); rmSync(evidenceRoot, { recursive: true, force: true }); rmSync(repo.dir, { recursive: true, force: true }); }
});

test("PUBLISH_UNCERTAIN never calls the AI proposal port", async () => {
  const evidenceRoot = mkdtempSync(join(tmpdir(), "flerdvision-w7-prohibited-"));
  const store = new SqliteControlPlaneStore(":memory:");
  let proposalCalls = 0;
  try {
    const incident = createIncident(store, { kind: "PUBLISH_UNCERTAIN", severity: "CRITICAL" });
    const diagnosisPort = { async diagnose() { return { classification: "PUBLISH_OUTCOME_UNCERTAIN", confidence: 1, rootCause: "outcome unknown", evidenceRationale: [], proposedRepairKind: "NO_AUTOMATED_REPAIR", requiresHuman: false, securityNotes: [] }; } };
    const proposalPort = { async propose() { proposalCalls++; throw new Error("must not be called"); } };
    const workspace = { createBranch() { throw new Error("must not branch"); }, runCommand() { throw new Error("must not run"); }, changedFiles() { return []; }, headSha() { return undefined; } };
    const service = new AiRepairService(store, store, new IncidentEvidenceBundleBuilder(store, new SafeLocalArtifactTextReader(evidenceRoot)), diagnosisPort, proposalPort, workspace);
    const report = await service.prepareRepair(incident.incidentId, { now: "2026-08-26T18:10:00Z", releaseSha: "x", adapterVersion: "x", baseRef: "HEAD" }, actor);
    assert.equal(report.verdict.decision, "PROHIBITED");
    assert.equal(proposalCalls, 0);
    assert.equal(report.productionPromotionAllowed, false);
  } finally { store.close(); rmSync(evidenceRoot, { recursive: true, force: true }); }
});

test("repair audit records are immutable at database level", () => {
  const dir = mkdtempSync(join(tmpdir(), "flerdvision-w7-immutable-"));
  const path = join(dir, "db.sqlite");
  const store = new SqliteControlPlaneStore(path);
  try {
    const incident = createIncident(store);
    const bundle = { bundleId: "bundle:immut", incidentId: incident.incidentId, capturedAt: "2026-08-26T18:00:00Z", releaseSha: "x", adapterVersion: "x", redactionPolicyVersion: "v", incidentKind: "UI_UNKNOWN", incidentSummary: "x", sanitizedContext: {}, artifacts: [], redactionFindings: [] };
    store.recordEvidenceBundle(bundle, actor);
  } finally { store.close(); }
  const raw = new DatabaseSync(path);
  try {
    assert.throws(() => raw.exec("UPDATE incident_evidence_bundles SET release_sha='tamper'"), /append-only/);
    assert.throws(() => raw.exec("DELETE FROM incident_evidence_bundles"), /append-only/);
  } finally { raw.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("patch-scope failure is audit-visible after a passing repair policy and never creates a branch", async () => {
  const evidenceRoot = mkdtempSync(join(tmpdir(), "flerdvision-w7-scope-fail-"));
  const store = new SqliteControlPlaneStore(":memory:");
  let branches = 0;
  try {
    const incident = createIncident(store);
    const diagnosisPort = { async diagnose() { return { classification: "SELECTOR_DRIFT", confidence: 0.9, rootCause: "selector drift", evidenceRationale: [], proposedRepairKind: "SELECTOR_CONFIG_CHANGE", requiresHuman: false, securityNotes: [] }; } };
    const unsafeDiff = `diff --git a/src/domain/safety.ts b/src/domain/safety.ts\nindex 1111111..2222222 100644\n--- a/src/domain/safety.ts\n+++ b/src/domain/safety.ts\n@@ -1 +1 @@\n-old\n+new\ndiff --git a/tests/w7-unsafe.test.mjs b/tests/w7-unsafe.test.mjs\nnew file mode 100644\n--- /dev/null\n+++ b/tests/w7-unsafe.test.mjs\n@@ -0,0 +1 @@\n+export {};\n`;
    const proposalPort = { async propose() { return { title: "unsafe", summary: "unsafe", unifiedDiff: unsafeDiff, regressionTestFiles: ["tests/w7-unsafe.test.mjs"], requestedTestCommands: [] }; } };
    const workspace = { createBranch() { branches++; throw new Error("must not branch"); }, runCommand() { throw new Error("must not run"); }, changedFiles() { return []; }, headSha() { return undefined; } };
    const service = new AiRepairService(store, store, new IncidentEvidenceBundleBuilder(store, new SafeLocalArtifactTextReader(evidenceRoot)), diagnosisPort, proposalPort, workspace);
    const report = await service.prepareRepair(incident.incidentId, { now: "2026-08-26T18:20:00Z", releaseSha: "x", adapterVersion: "x", baseRef: "HEAD" }, actor);
    assert.deepEqual(report.gates.map((x) => [x.gate, x.status]), [["POLICY", "PASS"], ["PATCH_SCOPE", "FAIL"]]);
    assert.equal(branches, 0);
    assert.equal(report.readyForHumanReview, false);
  } finally { store.close(); rmSync(evidenceRoot, { recursive: true, force: true }); }
});

test("all W7 repair audit entities are append-only at database level", () => {
  const dir = mkdtempSync(join(tmpdir(), "flerdvision-w7-all-immutable-"));
  const path = join(dir, "db.sqlite");
  const store = new SqliteControlPlaneStore(path);
  try {
    const incident = createIncident(store);
    const bundle = { bundleId: "bundle:all", incidentId: incident.incidentId, capturedAt: "2026-08-26T18:00:00Z", releaseSha: "x", adapterVersion: "x", redactionPolicyVersion: "v", incidentKind: "UI_UNKNOWN", incidentSummary: "x", sanitizedContext: {}, artifacts: [], redactionFindings: [] };
    store.recordEvidenceBundle(bundle, actor);
    const diag = { diagnosisId: "diag:all", bundleId: bundle.bundleId, incidentId: incident.incidentId, createdAt: "2026-08-26T18:01:00Z", classification: "SELECTOR_DRIFT", confidence: 0.9, rootCause: "x", evidenceRationale: [], proposedRepairKind: "SELECTOR_CONFIG_CHANGE", requiresHuman: false, securityNotes: [] };
    store.recordAiDiagnosis(diag, actor);
    const proposal = { proposalId: "proposal:all", diagnosisId: diag.diagnosisId, incidentId: incident.incidentId, createdAt: "2026-08-26T18:02:00Z", title: "x", summary: "x", unifiedDiff: "diff", changedFiles: ["config/platform-ui.test.json", "tests/w7-a.test.mjs"], regressionTestFiles: ["tests/w7-a.test.mjs"], requestedTestCommands: [] };
    store.recordRepairProposal(proposal, actor);
    store.recordRepairGateResult({ gateResultId: "gate:all", proposalId: proposal.proposalId, gate: "POLICY", status: "PASS", checkedAt: "2026-08-26T18:03:00Z", summary: "pass", artifactRefs: [] }, actor);
    store.recordRepairBranch({ branchRecordId: "branch:all", proposalId: proposal.proposalId, createdAt: "2026-08-26T18:04:00Z", branchName: "repair/all", baseRef: "abc", worktreePath: "/tmp/repair-all" }, actor);
  } finally { store.close(); }
  const raw = new DatabaseSync(path);
  try {
    for (const table of ["incident_evidence_bundles", "ai_diagnoses", "repair_proposals", "repair_gate_results", "repair_branches"]) {
      assert.throws(() => raw.exec(`DELETE FROM ${table}`), /append-only/, table);
    }
  } finally { raw.close(); rmSync(dir, { recursive: true, force: true }); }
});
