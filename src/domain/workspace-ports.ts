import type { QualificationGateResult, ReleaseQualificationRun, Workspace } from "./workspace.js";

export interface WorkspaceRegistryPort {
  create(workspace: Workspace): Workspace;
  get(workspaceId: string): Workspace | null;
  list(): readonly Workspace[];
  update(workspace: Workspace): Workspace;
}

export interface ReleaseQualificationStorePort {
  createRun(run: ReleaseQualificationRun): ReleaseQualificationRun;
  getRun(runId: string): ReleaseQualificationRun | null;
  listRuns(releaseSha?: string): readonly ReleaseQualificationRun[];
  appendGate(result: QualificationGateResult): QualificationGateResult;
  listGates(runId: string): readonly QualificationGateResult[];
  updateRunStatus(runId: string, status: ReleaseQualificationRun["status"]): ReleaseQualificationRun;
}

export interface FixedTestRunnerPort {
  run(testId: string, cwd: string): Promise<{ passed: boolean; summary: string; artifactRefs: readonly string[] }>;
  supportedTests(): readonly string[];
}
