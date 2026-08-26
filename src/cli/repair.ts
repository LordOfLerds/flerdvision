import { resolve } from "node:path";
import { SqliteControlPlaneStore } from "../adapters/storage/sqlite.js";
import { IncidentEvidenceBundleBuilder, SafeLocalArtifactTextReader } from "../adapters/repair/redaction.js";
import { CommandAiDiagnosisAdapter, CommandAiRepairProposalAdapter } from "../adapters/repair/command-ai.js";
import { GitRepairWorkspace } from "../adapters/repair/git-workspace.js";
import { AiRepairService } from "../application/ai-repair.js";

function argsMap(argv: readonly string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith("--")) continue;
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${token}`);
    map.set(token.slice(2), value); index += 1;
  }
  return map;
}

function required(map: Map<string, string>, key: string): string {
  const value = map.get(key);
  if (!value) throw new Error(`Missing --${key}`);
  return value;
}

function usage(): never {
  console.error(`Usage:\n  npm run repair -- show --db <path> --incident-id <id>\n  npm run repair -- bundle --db <path> --incident-id <id> --evidence-root <dir> --release-sha <sha> --adapter-version <v>\n  npm run repair -- prepare --db <path> --incident-id <id> --evidence-root <dir> --release-sha <sha> --adapter-version <v> --repo <dir> --base-ref <ref> --ai-command <wrapper> [--ai-args-json '["arg"]'] [--worktree-root <dir>]`);
  process.exitCode = 2;
  throw new Error("invalid arguments");
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command) return usage();
  const args = argsMap(rest);
  const store = new SqliteControlPlaneStore(required(args, "db"));
  try {
    const incidentId = required(args, "incident-id");
    if (command === "show") {
      console.log(JSON.stringify({
        incident: store.getIncident(incidentId),
        bundles: store.listEvidenceBundles(incidentId),
        diagnoses: store.listAiDiagnoses(incidentId),
        proposals: store.listRepairProposals(incidentId).map((proposal) => ({ ...proposal, unifiedDiff: `[${proposal.unifiedDiff.length} chars]`, gates: store.listRepairGateResults(proposal.proposalId), branch: store.getRepairBranch(proposal.proposalId) }))
      }, null, 2));
      return;
    }
    const evidenceRoot = resolve(required(args, "evidence-root"));
    const now = new Date().toISOString();
    const builder = new IncidentEvidenceBundleBuilder(store, new SafeLocalArtifactTextReader(evidenceRoot));
    const incident = store.getIncident(incidentId);
    if (!incident) throw new Error(`Unknown incident: ${incidentId}`);
    if (command === "bundle") {
      const bundle = builder.build(incident, { capturedAt: now, releaseSha: required(args, "release-sha"), adapterVersion: required(args, "adapter-version") });
      store.recordEvidenceBundle(bundle, { type: "operator", id: "repair-cli" });
      console.log(JSON.stringify(bundle, null, 2));
      return;
    }
    if (command === "prepare") {
      const aiCommand = required(args, "ai-command");
      const aiArgs = args.get("ai-args-json") ? JSON.parse(args.get("ai-args-json")!) as string[] : [];
      if (!Array.isArray(aiArgs) || aiArgs.some((item) => typeof item !== "string")) throw new Error("--ai-args-json must be a JSON string array");
      const commandOptions = { command: aiCommand, args: aiArgs };
      const workspace = new GitRepairWorkspace({ repositoryPath: resolve(required(args, "repo")), ...(args.get("worktree-root") ? { worktreeRoot: resolve(args.get("worktree-root")!) } : {}) });
      const service = new AiRepairService(store, store, builder, new CommandAiDiagnosisAdapter(commandOptions), new CommandAiRepairProposalAdapter(commandOptions), workspace);
      const report = await service.prepareRepair(incidentId, { now, releaseSha: required(args, "release-sha"), adapterVersion: required(args, "adapter-version"), baseRef: required(args, "base-ref") }, { type: "operator", id: "repair-cli" });
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    return usage();
  } finally { store.close(); }
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
