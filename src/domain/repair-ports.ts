import type { Actor } from "./control-plane.js";
import type { IncidentEvidenceBundle, AiDiagnosis, RepairProposal, RepairGateResult, RepairBranchRecord } from "./repair.js";
import type { Incident } from "./operations.js";

export interface RepairStorePort {
  recordEvidenceBundle(bundle: IncidentEvidenceBundle, actor: Actor): IncidentEvidenceBundle;
  getEvidenceBundle(bundleId: string): IncidentEvidenceBundle | null;
  listEvidenceBundles(incidentId?: string): readonly IncidentEvidenceBundle[];
  recordAiDiagnosis(diagnosis: AiDiagnosis, actor: Actor): AiDiagnosis;
  listAiDiagnoses(incidentId?: string): readonly AiDiagnosis[];
  recordRepairProposal(proposal: RepairProposal, actor: Actor): RepairProposal;
  getRepairProposal(proposalId: string): RepairProposal | null;
  listRepairProposals(incidentId?: string): readonly RepairProposal[];
  recordRepairGateResult(result: RepairGateResult, actor: Actor): RepairGateResult;
  listRepairGateResults(proposalId: string): readonly RepairGateResult[];
  recordRepairBranch(record: RepairBranchRecord, actor: Actor): RepairBranchRecord;
  getRepairBranch(proposalId: string): RepairBranchRecord | null;
}

export interface IncidentEvidenceBundleBuilderPort {
  build(incident: Incident, params: { capturedAt: string; releaseSha: string; adapterVersion: string }): IncidentEvidenceBundle;
}

export interface AiDiagnosisPort {
  diagnose(bundle: IncidentEvidenceBundle): Promise<Omit<AiDiagnosis, "diagnosisId" | "bundleId" | "incidentId" | "createdAt">>;
}

export interface AiRepairProposalPort {
  propose(bundle: IncidentEvidenceBundle, diagnosis: AiDiagnosis): Promise<Omit<RepairProposal, "proposalId" | "diagnosisId" | "incidentId" | "createdAt" | "changedFiles">>;
}

export interface RepairWorkspacePort {
  createBranch(params: { proposalId: string; branchName: string; baseRef: string; unifiedDiff: string; createdAt: string }): RepairBranchRecord;
  runCommand(branch: RepairBranchRecord, command: readonly string[]): { exitCode: number; stdout: string; stderr: string };
  changedFiles(branch: RepairBranchRecord): readonly string[];
  headSha(branch: RepairBranchRecord): string | undefined;
}

export interface PrepareOnlyRepairReplayPort {
  replay(params: { incidentId: string; proposal: RepairProposal; branch: RepairBranchRecord }): Promise<{ passed: boolean; summary: string; artifactRefs?: readonly string[] }>;
}
