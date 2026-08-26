import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import type { RepairWorkspacePort } from "../../domain/repair-ports.js";
import type { RepairBranchRecord } from "../../domain/repair.js";

function run(cwd: string, command: string, args: readonly string[], input?: string) {
  const options: { cwd: string; input?: string; encoding: string; timeout: number; maxBuffer: number; env: Record<string, string> } = {
    cwd, encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
    env: { PATH: process.env.PATH ?? "", LANG: process.env.LANG ?? "C.UTF-8" }
  };
  if (input !== undefined) options.input = input;
  return spawnSync(command, [...args], options);
}

export interface GitRepairWorkspaceOptions {
  repositoryPath: string;
  worktreeRoot?: string;
}

export class GitRepairWorkspace implements RepairWorkspacePort {
  private readonly repo: string;
  private readonly root: string;
  constructor(options: GitRepairWorkspaceOptions) {
    this.repo = resolve(options.repositoryPath);
    this.root = resolve(options.worktreeRoot ?? join(tmpdir(), "flerdvision-repair-worktrees"));
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }

  createBranch(params: { proposalId: string; branchName: string; baseRef: string; unifiedDiff: string; createdAt: string }): RepairBranchRecord {
    const dir = mkdtempSync(join(this.root, "repair-"));
    const add = run(this.repo, "git", ["worktree", "add", "-b", params.branchName, dir, params.baseRef]);
    if (add.status !== 0) { rmSync(dir, { recursive: true, force: true }); throw new Error(`git worktree add failed: ${add.stderr}`); }
    const patchPath = join(dir, ".flerdvision-repair.patch");
    writeFileSync(patchPath, params.unifiedDiff, { encoding: "utf8", mode: 0o600 });
    const apply = run(dir, "git", ["apply", "--index", "--whitespace=error-all", patchPath]);
    rmSync(patchPath, { force: true });
    if (apply.status !== 0) {
      run(this.repo, "git", ["worktree", "remove", "--force", dir]);
      run(this.repo, "git", ["branch", "-D", params.branchName]);
      throw new Error(`git apply failed: ${apply.stderr}`);
    }
    const sha = run(dir, "git", ["rev-parse", "HEAD"]);
    const record: RepairBranchRecord = {
      branchRecordId: `repair-branch:${params.proposalId}`,
      proposalId: params.proposalId,
      createdAt: new Date(params.createdAt).toISOString(),
      branchName: params.branchName,
      baseRef: params.baseRef,
      worktreePath: dir
    };
    if (sha.status === 0) Object.assign(record, { headSha: sha.stdout.trim() });
    return record;
  }

  runCommand(branch: RepairBranchRecord, command: readonly string[]) {
    const [program, ...args] = command;
    if (!program) throw new Error("Repair command cannot be empty");
    const result = run(branch.worktreePath, program, args);
    return { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
  }

  changedFiles(branch: RepairBranchRecord): readonly string[] {
    const result = run(branch.worktreePath, "git", ["diff", "--cached", "--name-only", "--diff-filter=ACM"]);
    if (result.status !== 0) throw new Error(`git changed-files failed: ${result.stderr}`);
    return result.stdout.split(/\r?\n/).map((x) => x.trim()).filter(Boolean).sort();
  }

  headSha(branch: RepairBranchRecord): string | undefined {
    const result = run(branch.worktreePath, "git", ["rev-parse", "HEAD"]);
    return result.status === 0 ? result.stdout.trim() : undefined;
  }
}
