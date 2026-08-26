import { createHash } from "node:crypto";
import type { Actor } from "../domain/control-plane.js";
import type { IncidentStorePort } from "../domain/operations-ports.js";
import type {
  AiDiagnosisPort,
  AiRepairProposalPort,
  IncidentEvidenceBundleBuilderPort,
  RepairStorePort,
  RepairWorkspacePort,
  PrepareOnlyRepairReplayPort
} from "../domain/repair-ports.js";
import type {
  AiDiagnosis,
  IncidentEvidenceBundle,
  RepairExecutionReport,
  RepairGateResult,
  RepairPolicyVerdict,
  RepairProposal
} from "../domain/repair.js";

function stableId(prefix: string, value: string): string {
  return `${prefix}:${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

function iso(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid timestamp: ${value}`);
  return date.toISOString();
}

const ABSOLUTE_DENIED_PREFIXES = [
  ".git/", ".env", "runtime/", "src/domain/safety", "src/domain/states", "src/domain/verification",
  "src/application/durable-final-action", "src/application/reconciliation", "src/adapters/verify/manual",
  "src/application/operations", "src/domain/operations", "src/adapters/storage/sqlite"
] as const;

const AUTO_ALLOWED_PREFIXES = ["config/platform-ui", "config/repair-overrides/", "tests/fixtures/", "tests/w7-"] as const;
const REVIEW_ALLOWED_PREFIXES = ["src/adapters/browser/", "src/adapters/publish/", ...AUTO_ALLOWED_PREFIXES] as const;

const CLASSIFICATIONS = new Set(["SELECTOR_DRIFT","UI_WORKFLOW_DRIFT","TRANSIENT_TECHNICAL","AUTHENTICATION_REQUIRED","ACCOUNT_IDENTITY_RISK","POLICY_OR_COPYRIGHT","PUBLISH_OUTCOME_UNCERTAIN","SOURCE_DATA_ISSUE","UNKNOWN"]);
const REPAIR_KINDS = new Set(["SELECTOR_CONFIG_CHANGE","UI_WORKFLOW_CONFIG_CHANGE","WAIT_CONDITION_CHANGE","CODE_CHANGE","NO_AUTOMATED_REPAIR"]);

function stringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`AI ${field} must be an array of strings`);
  return value as string[];
}

export function validateAiDiagnosisDraft(value: unknown): Omit<AiDiagnosis, "diagnosisId" | "bundleId" | "incidentId" | "createdAt"> {
  if (!value || typeof value !== "object") throw new Error("AI diagnosis must be an object");
  const item = value as Record<string, unknown>;
  if (typeof item.classification !== "string" || !CLASSIFICATIONS.has(item.classification)) throw new Error(`AI diagnosis has invalid classification: ${String(item.classification)}`);
  if (typeof item.confidence !== "number" || !Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1) throw new Error("AI diagnosis confidence must be between 0 and 1");
  if (typeof item.rootCause !== "string" || !item.rootCause.trim()) throw new Error("AI diagnosis requires rootCause");
  if (typeof item.proposedRepairKind !== "string" || !REPAIR_KINDS.has(item.proposedRepairKind)) throw new Error(`AI diagnosis has invalid proposedRepairKind: ${String(item.proposedRepairKind)}`);
  if (typeof item.requiresHuman !== "boolean") throw new Error("AI diagnosis requires boolean requiresHuman");
  return {
    classification: item.classification as AiDiagnosis["classification"], confidence: item.confidence, rootCause: item.rootCause,
    evidenceRationale: stringArray(item.evidenceRationale, "evidenceRationale"), proposedRepairKind: item.proposedRepairKind as AiDiagnosis["proposedRepairKind"],
    requiresHuman: item.requiresHuman, securityNotes: stringArray(item.securityNotes, "securityNotes")
  };
}

function validateProposalDraft(value: unknown): Omit<RepairProposal, "proposalId" | "diagnosisId" | "incidentId" | "createdAt" | "changedFiles"> {
  if (!value || typeof value !== "object") throw new Error("AI repair proposal must be an object");
  const item = value as Record<string, unknown>;
  for (const key of ["title","summary","unifiedDiff"] as const) if (typeof item[key] !== "string" || !(item[key] as string).trim()) throw new Error(`AI repair proposal requires ${key}`);
  return { title: item.title as string, summary: item.summary as string, unifiedDiff: item.unifiedDiff as string, regressionTestFiles: stringArray(item.regressionTestFiles, "regressionTestFiles"), requestedTestCommands: stringArray(item.requestedTestCommands, "requestedTestCommands") };
}

export class RepairPolicy {
  evaluate(incidentKind: string, diagnosis: AiDiagnosis): RepairPolicyVerdict {
    const humanOnlyKinds = new Set(["AUTH_REQUIRED", "CHALLENGE", "IDENTITY_MISMATCH", "POLICY_WARNING", "COPYRIGHT_WARNING", "ACCOUNT_WARNING"]);
    if (incidentKind === "PUBLISH_UNCERTAIN" || diagnosis.classification === "PUBLISH_OUTCOME_UNCERTAIN") {
      return {
        decision: "PROHIBITED",
        reason: "uncertain publication outcome belongs exclusively to deterministic reconciliation; AI may not authorize retry",
        allowedPathPrefixes: [], deniedPathPrefixes: ABSOLUTE_DENIED_PREFIXES,
        requireRegressionTest: true, allowPrepareOnlyReplay: false
      };
    }
    if (humanOnlyKinds.has(incidentKind) || diagnosis.requiresHuman || diagnosis.classification === "AUTHENTICATION_REQUIRED" || diagnosis.classification === "ACCOUNT_IDENTITY_RISK" || diagnosis.classification === "POLICY_OR_COPYRIGHT") {
      return {
        decision: "HUMAN_ONLY",
        reason: "incident requires a human decision or authentication action",
        allowedPathPrefixes: [], deniedPathPrefixes: ABSOLUTE_DENIED_PREFIXES,
        requireRegressionTest: false, allowPrepareOnlyReplay: false
      };
    }
    if (diagnosis.proposedRepairKind === "SELECTOR_CONFIG_CHANGE" || diagnosis.proposedRepairKind === "WAIT_CONDITION_CHANGE") {
      return {
        decision: "AUTO_CANDIDATE",
        reason: "narrow UI selector/wait repair can be prepared automatically but never promoted directly to production",
        allowedPathPrefixes: AUTO_ALLOWED_PREFIXES, deniedPathPrefixes: ABSOLUTE_DENIED_PREFIXES,
        requireRegressionTest: true, allowPrepareOnlyReplay: true
      };
    }
    if (diagnosis.proposedRepairKind === "UI_WORKFLOW_CONFIG_CHANGE" || diagnosis.proposedRepairKind === "CODE_CHANGE") {
      return {
        decision: "ENGINEERING_REVIEW_REQUIRED",
        reason: "workflow/code repair may be prepared on a branch but requires engineering review before any real-account replay",
        allowedPathPrefixes: REVIEW_ALLOWED_PREFIXES, deniedPathPrefixes: ABSOLUTE_DENIED_PREFIXES,
        requireRegressionTest: true, allowPrepareOnlyReplay: false
      };
    }
    return {
      decision: "HUMAN_ONLY",
      reason: "diagnosis did not identify a bounded automated repair",
      allowedPathPrefixes: [], deniedPathPrefixes: ABSOLUTE_DENIED_PREFIXES,
      requireRegressionTest: false, allowPrepareOnlyReplay: false
    };
  }
}

export class RepairPatchValidationError extends Error {}

export class RepairPatchValidator {
  validate(proposal: RepairProposal, verdict: RepairPolicyVerdict): void {
    if (proposal.unifiedDiff.length > 200_000) throw new RepairPatchValidationError("Repair diff exceeds 200 KB safety limit");
    if (/^deleted file mode /m.test(proposal.unifiedDiff) || /^rename (?:from|to) /m.test(proposal.unifiedDiff) || /^Binary files /m.test(proposal.unifiedDiff)) {
      throw new RepairPatchValidationError("AI repair patches may not delete, rename, or contain binary file changes");
    }
    if (verdict.decision === "PROHIBITED" || verdict.decision === "HUMAN_ONLY") {
      throw new RepairPatchValidationError(`Repair proposal is not permitted for policy decision ${verdict.decision}`);
    }
    if (proposal.changedFiles.length === 0) throw new RepairPatchValidationError("Repair proposal changes no files");
    if (proposal.changedFiles.length > 8) throw new RepairPatchValidationError("Repair proposal changes too many files (>8)");
    for (const file of proposal.changedFiles) {
      if (file.startsWith("/") || file.includes("..")) throw new RepairPatchValidationError(`Unsafe repair path: ${file}`);
      if (verdict.deniedPathPrefixes.some((prefix) => file === prefix || file.startsWith(prefix))) {
        throw new RepairPatchValidationError(`Repair touches denied path: ${file}`);
      }
      if (!verdict.allowedPathPrefixes.some((prefix) => file.startsWith(prefix))) {
        throw new RepairPatchValidationError(`Repair path is outside allowed scope: ${file}`);
      }
    }
    if (verdict.requireRegressionTest && proposal.regressionTestFiles.length === 0) {
      throw new RepairPatchValidationError("Repair proposal requires at least one regression test file");
    }
    for (const testFile of proposal.regressionTestFiles) {
      if (!proposal.changedFiles.includes(testFile)) throw new RepairPatchValidationError(`Regression test is not part of changed files: ${testFile}`);
      if (!testFile.startsWith("tests/") || !testFile.endsWith(".test.mjs")) throw new RepairPatchValidationError(`Invalid regression test path: ${testFile}`);
    }
    const forbiddenTokens = ["manual_not_published", "allowFinalPublish", "PUBLISH_UNCERTAIN", "kill_switch", "invokeFinalAction", "CAPTCHA", "2FA"];
    for (const token of forbiddenTokens) {
      if (proposal.unifiedDiff.includes(token)) throw new RepairPatchValidationError(`Repair diff contains protected token: ${token}`);
    }
  }
}

function gateResult(proposalId: string, gate: RepairGateResult["gate"], status: RepairGateResult["status"], checkedAt: string, summary: string, artifactRefs: readonly string[] = []): RepairGateResult {
  return {
    gateResultId: stableId("repair-gate", `${proposalId}|${gate}|${status}|${summary}`),
    proposalId, gate, status, checkedAt: iso(checkedAt), summary, artifactRefs
  };
}

export interface AiRepairServiceOptions {
  fullSuiteCommand?: readonly string[];
  regressionCommand?: readonly string[];
}

export class AiRepairService {
  private readonly fullSuiteCommand: readonly string[];
  private readonly regressionCommand: readonly string[];

  constructor(
    private readonly incidents: IncidentStorePort,
    private readonly repairStore: RepairStorePort,
    private readonly bundleBuilder: IncidentEvidenceBundleBuilderPort,
    private readonly diagnosisPort: AiDiagnosisPort,
    private readonly proposalPort: AiRepairProposalPort,
    private readonly workspace: RepairWorkspacePort,
    private readonly replay: PrepareOnlyRepairReplayPort | undefined = undefined,
    private readonly policy = new RepairPolicy(),
    private readonly patchValidator = new RepairPatchValidator(),
    options: AiRepairServiceOptions = {}
  ) {
    this.regressionCommand = options.regressionCommand ?? ["npm", "run", "test:w7"];
    this.fullSuiteCommand = options.fullSuiteCommand ?? ["npm", "test"];
  }

  async diagnoseIncident(incidentId: string, params: { now: string; releaseSha: string; adapterVersion: string }, actor: Actor = { type: "system", id: "ai-repair" }): Promise<{ bundle: IncidentEvidenceBundle; diagnosis: AiDiagnosis; verdict: RepairPolicyVerdict }> {
    const incident = this.incidents.getIncident(incidentId);
    if (!incident) throw new Error(`Unknown incident: ${incidentId}`);
    const bundle = this.repairStore.recordEvidenceBundle(this.bundleBuilder.build(incident, { capturedAt: params.now, releaseSha: params.releaseSha, adapterVersion: params.adapterVersion }), actor);
    const raw = validateAiDiagnosisDraft(await this.diagnosisPort.diagnose(bundle));
    const diagnosis: AiDiagnosis = {
      ...raw,
      diagnosisId: stableId("diagnosis", `${bundle.bundleId}|${JSON.stringify(raw)}`),
      bundleId: bundle.bundleId,
      incidentId,
      createdAt: iso(params.now)
    };
    this.repairStore.recordAiDiagnosis(diagnosis, actor);
    return { bundle, diagnosis, verdict: this.policy.evaluate(incident.kind, diagnosis) };
  }

  async prepareRepair(incidentId: string, params: { now: string; releaseSha: string; adapterVersion: string; baseRef: string }, actor: Actor = { type: "system", id: "ai-repair" }): Promise<RepairExecutionReport> {
    const diagnosed = await this.diagnoseIncident(incidentId, params, actor);
    if (diagnosed.verdict.decision === "PROHIBITED" || diagnosed.verdict.decision === "HUMAN_ONLY") {
      return { verdict: diagnosed.verdict, gates: [], readyForHumanReview: diagnosed.verdict.decision === "HUMAN_ONLY", productionPromotionAllowed: false };
    }

    const rawProposal = validateProposalDraft(await this.proposalPort.propose(diagnosed.bundle, diagnosed.diagnosis));
    const changedFiles = extractChangedFiles(rawProposal.unifiedDiff);
    const proposal: RepairProposal = {
      ...rawProposal,
      proposalId: stableId("repair-proposal", `${diagnosed.diagnosis.diagnosisId}|${createHash("sha256").update(rawProposal.unifiedDiff).digest("hex")}`),
      diagnosisId: diagnosed.diagnosis.diagnosisId,
      incidentId,
      createdAt: iso(params.now),
      changedFiles
    };
    this.repairStore.recordRepairProposal(proposal, actor);
    const gates: RepairGateResult[] = [];
    const policyGate = gateResult(proposal.proposalId, "POLICY", "PASS", params.now, diagnosed.verdict.reason);
    this.repairStore.recordRepairGateResult(policyGate, actor); gates.push(policyGate);
    try {
      this.patchValidator.validate(proposal, diagnosed.verdict);
      const scopeGate = gateResult(proposal.proposalId, "PATCH_SCOPE", "PASS", params.now, `validated ${changedFiles.length} changed files`);
      this.repairStore.recordRepairGateResult(scopeGate, actor); gates.push(scopeGate);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failed = gateResult(proposal.proposalId, "PATCH_SCOPE", "FAIL", params.now, message);
      this.repairStore.recordRepairGateResult(failed, actor); gates.push(failed);
      return { proposal, verdict: diagnosed.verdict, gates, readyForHumanReview: false, productionPromotionAllowed: false };
    }

    const branchName = `repair/${incidentId.replace(/[^a-zA-Z0-9._-]+/g, "-")}/${proposal.proposalId.slice(-12)}`;
    const branch = this.workspace.createBranch({ proposalId: proposal.proposalId, branchName, baseRef: params.baseRef, unifiedDiff: proposal.unifiedDiff, createdAt: params.now });
    this.repairStore.recordRepairBranch(branch, actor);

    const actualChanged = this.workspace.changedFiles(branch);
    if (JSON.stringify([...actualChanged].sort()) !== JSON.stringify([...proposal.changedFiles].sort())) {
      const mismatch = gateResult(proposal.proposalId, "PATCH_SCOPE", "FAIL", params.now, "git worktree changed-file set does not match AI-declared patch");
      this.repairStore.recordRepairGateResult(mismatch, actor); gates.push(mismatch);
      return { proposal, verdict: diagnosed.verdict, branch, gates, readyForHumanReview: false, productionPromotionAllowed: false };
    }

    const regression = this.workspace.runCommand(branch, this.regressionCommand);
    const regressionGate = gateResult(proposal.proposalId, "REGRESSION", regression.exitCode === 0 ? "PASS" : "FAIL", params.now,
      regression.exitCode === 0 ? "repair regression suite passed" : `repair regression suite failed: ${regression.stderr.slice(0, 500)}`);
    this.repairStore.recordRepairGateResult(regressionGate, actor); gates.push(regressionGate);
    if (regression.exitCode !== 0) return { proposal, verdict: diagnosed.verdict, branch, gates, readyForHumanReview: false, productionPromotionAllowed: false };

    const full = this.workspace.runCommand(branch, this.fullSuiteCommand);
    const fullGate = gateResult(proposal.proposalId, "FULL_SUITE", full.exitCode === 0 ? "PASS" : "FAIL", params.now,
      full.exitCode === 0 ? "full project suite passed" : `full project suite failed: ${full.stderr.slice(0, 500)}`);
    this.repairStore.recordRepairGateResult(fullGate, actor); gates.push(fullGate);
    if (full.exitCode !== 0) return { proposal, verdict: diagnosed.verdict, branch, gates, readyForHumanReview: false, productionPromotionAllowed: false };

    if (diagnosed.verdict.allowPrepareOnlyReplay && this.replay) {
      const replay = await this.replay.replay({ incidentId, proposal, branch });
      const replayGate = gateResult(proposal.proposalId, "PREPARE_ONLY", replay.passed ? "PASS" : "FAIL", params.now, replay.summary, replay.artifactRefs ?? []);
      this.repairStore.recordRepairGateResult(replayGate, actor); gates.push(replayGate);
      if (!replay.passed) return { proposal, verdict: diagnosed.verdict, branch, gates, readyForHumanReview: false, productionPromotionAllowed: false };
    } else {
      const replayGate = gateResult(proposal.proposalId, "PREPARE_ONLY", "PENDING", params.now, diagnosed.verdict.allowPrepareOnlyReplay ? "prepare-only replay adapter not configured" : "prepare-only replay requires engineering review before execution");
      this.repairStore.recordRepairGateResult(replayGate, actor); gates.push(replayGate);
    }

    return {
      proposal, verdict: diagnosed.verdict, branch, gates,
      readyForHumanReview: gates.every((gate) => gate.status === "PASS" || gate.status === "PENDING"),
      productionPromotionAllowed: false
    };
  }
}

export function extractChangedFiles(unifiedDiff: string): readonly string[] {
  const files = new Set<string>();
  for (const line of unifiedDiff.split(/\r?\n/)) {
    const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (!match) continue;
    const left = match[1]; const right = match[2];
    if (!left || !right || left !== right) throw new RepairPatchValidationError("Renames/moves are not allowed in AI repair patches");
    files.add(right);
  }
  return [...files].sort();
}
