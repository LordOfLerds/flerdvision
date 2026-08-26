import { mkdirSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { WorkspaceRegistryPort } from "../domain/workspace-ports.js";
import { assertWorkspaceId, type Workspace, type WorkspaceRuntimeLayout } from "../domain/workspace.js";

function privateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o077) !== 0) throw new Error(`Workspace runtime directory is not private: ${path} mode=${mode.toString(8)}`);
}

export function workspaceRuntimeLayout(runtimeRoot: string, workspaceId: string): WorkspaceRuntimeLayout {
  const safe = assertWorkspaceId(workspaceId);
  const root = resolve(runtimeRoot);
  const workspaceRoot = resolve(root, "workspaces", safe);
  if (!(workspaceRoot === root || workspaceRoot.startsWith(root + sep))) throw new Error("Workspace path escaped runtime root");
  return {
    workspaceRoot,
    databasePath: resolve(workspaceRoot, "database", "flerdvision.sqlite"),
    profilesDir: resolve(workspaceRoot, "profiles"),
    evidenceDir: resolve(workspaceRoot, "evidence"),
    mediaCacheDir: resolve(workspaceRoot, "media-cache"),
    configDir: resolve(workspaceRoot, "config"),
    logsDir: resolve(workspaceRoot, "logs")
  };
}

export function initializeWorkspaceRuntime(runtimeRoot: string, workspaceId: string): WorkspaceRuntimeLayout {
  const layout = workspaceRuntimeLayout(runtimeRoot, workspaceId);
  privateDir(layout.workspaceRoot);
  privateDir(resolve(layout.workspaceRoot, "database"));
  privateDir(layout.profilesDir);
  privateDir(layout.evidenceDir);
  privateDir(layout.mediaCacheDir);
  privateDir(layout.configDir);
  privateDir(layout.logsDir);
  return layout;
}

export class WorkspaceService {
  constructor(private readonly registry: WorkspaceRegistryPort, private readonly runtimeRoot: string) {}

  create(input: { workspaceId: string; displayName: string; timezone?: string; now: string }): { workspace: Workspace; layout: WorkspaceRuntimeLayout } {
    const workspaceId = assertWorkspaceId(input.workspaceId);
    const displayName = input.displayName.trim();
    const timezone = input.timezone ?? "Europe/Vienna";
    if (!displayName) throw new Error("Workspace display name is required");
    const existing = this.registry.get(workspaceId);
    if (existing) {
      if (existing.displayName !== displayName || existing.timezone !== timezone) throw new Error(`Workspace ${workspaceId} already exists with different name/timezone`);
      return { workspace: existing, layout: initializeWorkspaceRuntime(this.runtimeRoot, workspaceId) };
    }
    const created = this.registry.create({ workspaceId, displayName, timezone, createdAt: new Date(input.now).toISOString(), status: "SETUP" });
    return { workspace: created, layout: initializeWorkspaceRuntime(this.runtimeRoot, created.workspaceId) };
  }

  setReady(workspaceId: string): Workspace {
    const current = this.registry.get(assertWorkspaceId(workspaceId));
    if (!current) throw new Error(`Unknown workspace: ${workspaceId}`);
    return this.registry.update({ ...current, status: "READY" });
  }
}
