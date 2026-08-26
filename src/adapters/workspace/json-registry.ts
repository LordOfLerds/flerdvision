import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ReleaseQualificationStorePort, WorkspaceRegistryPort } from "../../domain/workspace-ports.js";
import type { QualificationGateResult, QualificationStatus, ReleaseQualificationRun, Workspace } from "../../domain/workspace.js";
import { assertWorkspaceId } from "../../domain/workspace.js";

interface RegistryDocument {
  version: 1;
  workspaces: Workspace[];
  qualificationRuns: ReleaseQualificationRun[];
  qualificationGates: QualificationGateResult[];
}

function initial(): RegistryDocument { return { version: 1, workspaces: [], qualificationRuns: [], qualificationGates: [] }; }

export class JsonWorkspaceRegistry implements WorkspaceRegistryPort, ReleaseQualificationStorePort {
  constructor(private readonly path: string) { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); }

  private load(): RegistryDocument {
    if (!existsSync(this.path)) return initial();
    const parsed = JSON.parse(readFileSync(this.path, "utf8")) as RegistryDocument;
    if (parsed.version !== 1 || !Array.isArray(parsed.workspaces) || !Array.isArray(parsed.qualificationRuns) || !Array.isArray(parsed.qualificationGates)) throw new Error("Invalid workspace registry document");
    return parsed;
  }

  private save(doc: RegistryDocument): void {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(doc, null, 2), { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, this.path);
  }

  create(workspace: Workspace): Workspace {
    const doc = this.load(); const id = assertWorkspaceId(workspace.workspaceId);
    const existing = doc.workspaces.find((item) => item.workspaceId === id);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify({ ...workspace, workspaceId: id })) throw new Error(`Workspace ${id} already exists with different configuration`);
      return existing;
    }
    const created = { ...workspace, workspaceId: id };
    doc.workspaces.push(created); this.save(doc); return created;
  }
  get(workspaceId: string): Workspace | null { return this.load().workspaces.find((item) => item.workspaceId === assertWorkspaceId(workspaceId)) ?? null; }
  list(): readonly Workspace[] { return [...this.load().workspaces].sort((a,b) => a.workspaceId.localeCompare(b.workspaceId)); }
  update(workspace: Workspace): Workspace {
    const doc = this.load(); const id = assertWorkspaceId(workspace.workspaceId); const index = doc.workspaces.findIndex((item) => item.workspaceId === id);
    if (index < 0) throw new Error(`Unknown workspace: ${id}`); doc.workspaces[index] = { ...workspace, workspaceId: id }; this.save(doc); return doc.workspaces[index]!;
  }

  createRun(run: ReleaseQualificationRun): ReleaseQualificationRun {
    const doc = this.load(); const existing = doc.qualificationRuns.find((item) => item.runId === run.runId);
    if (existing) { if (JSON.stringify(existing) !== JSON.stringify(run)) throw new Error(`Qualification run ${run.runId} conflicts`); return existing; }
    doc.qualificationRuns.push(run); this.save(doc); return run;
  }
  getRun(runId: string): ReleaseQualificationRun | null { return this.load().qualificationRuns.find((item) => item.runId === runId) ?? null; }
  listRuns(releaseSha?: string): readonly ReleaseQualificationRun[] { return this.load().qualificationRuns.filter((item) => !releaseSha || item.releaseSha === releaseSha); }
  appendGate(result: QualificationGateResult): QualificationGateResult {
    const doc = this.load(); const existing = doc.qualificationGates.find((item) => item.gateResultId === result.gateResultId);
    if (existing) { if (JSON.stringify(existing) !== JSON.stringify(result)) throw new Error(`Qualification gate ${result.gateResultId} conflicts`); return existing; }
    if (!doc.qualificationRuns.some((item) => item.runId === result.runId)) throw new Error(`Unknown qualification run: ${result.runId}`);
    doc.qualificationGates.push(result); this.save(doc); return result;
  }
  listGates(runId: string): readonly QualificationGateResult[] { return this.load().qualificationGates.filter((item) => item.runId === runId); }
  updateRunStatus(runId: string, status: QualificationStatus): ReleaseQualificationRun {
    const doc = this.load(); const index = doc.qualificationRuns.findIndex((item) => item.runId === runId);
    if (index < 0) throw new Error(`Unknown qualification run: ${runId}`);
    const updated = { ...doc.qualificationRuns[index]!, status }; doc.qualificationRuns[index] = updated; this.save(doc); return updated;
  }
}
