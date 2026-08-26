import { spawnSync } from "node:child_process";
import type { AiDiagnosisPort, AiRepairProposalPort } from "../../domain/repair-ports.js";
import type { AiDiagnosis, IncidentEvidenceBundle, RepairProposal } from "../../domain/repair.js";

export interface CommandAiAdapterOptions {
  command: string;
  args?: readonly string[];
  timeoutMs?: number;
  env?: Readonly<Record<string, string>>;
}

const ALLOWED_AI_ENV_KEYS = new Set(["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]);

function safeAiEnvironment(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", LANG: process.env.LANG ?? "C.UTF-8" };
  for (const [key, value] of Object.entries(extra)) {
    if (!ALLOWED_AI_ENV_KEYS.has(key)) throw new Error(`AI command environment key is not allowlisted: ${key}`);
    env[key] = value;
  }
  return env;
}

function runJsonCommand<T>(options: CommandAiAdapterOptions, payload: unknown): T {
  const result = spawnSync(options.command, [...(options.args ?? [])], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    timeout: options.timeoutMs ?? 120_000,
    maxBuffer: 4 * 1024 * 1024,
    env: safeAiEnvironment(options.env)
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`AI command failed (${result.status}): ${result.stderr.slice(0, 1000)}`);
  const raw = result.stdout.trim();
  if (!raw) throw new Error("AI command returned empty stdout");
  return JSON.parse(raw) as T;
}

export class CommandAiDiagnosisAdapter implements AiDiagnosisPort {
  constructor(private readonly options: CommandAiAdapterOptions) {}
  async diagnose(bundle: IncidentEvidenceBundle): Promise<Omit<AiDiagnosis, "diagnosisId" | "bundleId" | "incidentId" | "createdAt">> {
    return runJsonCommand(this.options, {
      contract: "flerdvision.ai-diagnosis.v1",
      instruction: "Return JSON only. Diagnose the incident using only the sanitized bundle. Never request secrets, bypass authentication/challenges, switch accounts, override policy/copyright warnings, or authorize retry of an uncertain publication.",
      bundle
    });
  }
}

export class CommandAiRepairProposalAdapter implements AiRepairProposalPort {
  constructor(private readonly options: CommandAiAdapterOptions) {}
  async propose(bundle: IncidentEvidenceBundle, diagnosis: AiDiagnosis): Promise<Omit<RepairProposal, "proposalId" | "diagnosisId" | "incidentId" | "createdAt" | "changedFiles">> {
    return runJsonCommand(this.options, {
      contract: "flerdvision.ai-repair-proposal.v1",
      instruction: "Return JSON only. Produce one narrow unified git diff plus regression tests. Do not touch safety, verification/reconciliation, operations kill-switch, storage, credentials, runtime profiles, final-publish semantics, CAPTCHA/2FA/authentication logic, or customer data.",
      bundle,
      diagnosis
    });
  }
}
