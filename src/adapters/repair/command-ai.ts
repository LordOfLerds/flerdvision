import { spawn } from "node:child_process";
import type { AiDiagnosisPort, AiRepairProposalPort } from "../../domain/repair-ports.js";
import type { AiDiagnosis, IncidentEvidenceBundle, RepairProposal } from "../../domain/repair.js";

export interface CommandAiAdapterOptions {
  command: string;
  args?: readonly string[];
  timeoutMs?: number;
  env?: Readonly<Record<string, string>>;
}

const ALLOWED_AI_ENV_KEYS = new Set(["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]);
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

function safeAiEnvironment(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", LANG: process.env.LANG ?? "C.UTF-8" };
  for (const [key, value] of Object.entries(extra)) {
    if (!ALLOWED_AI_ENV_KEYS.has(key)) throw new Error(`AI command environment key is not allowlisted: ${key}`);
    env[key] = value;
  }
  return env;
}

function runJsonCommand<T>(options: CommandAiAdapterOptions, payload: unknown): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new Error("AI command timeoutMs must be a positive number");
  const env = safeAiEnvironment(options.env);

  return new Promise<T>((resolve, reject) => {
    const child = spawn(options.command, [...(options.args ?? [])], {
      env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "", stderr = "", settled = false;

    const finish = (error?: Error, value?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value as T);
    };
    const abortForOutput = () => {
      child.kill("SIGKILL");
      finish(new Error(`AI command output exceeded ${MAX_OUTPUT_BYTES} byte safety limit`));
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(`AI command timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES) abortForOutput();
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (Buffer.byteLength(stderr) > MAX_OUTPUT_BYTES) abortForOutput();
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code, signal) => {
      if (settled) return;
      if (code !== 0) {
        finish(new Error(`AI command failed (${code ?? signal ?? "unknown"}): ${stderr.slice(0, 1000)}`));
        return;
      }
      const raw = stdout.trim();
      if (!raw) { finish(new Error("AI command returned empty stdout")); return; }
      try { finish(undefined, JSON.parse(raw) as T); }
      catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    });

    try { child.stdin.end(JSON.stringify(payload)); }
    catch (error) { child.kill("SIGKILL"); finish(error instanceof Error ? error : new Error(String(error))); }
  });
}

export class CommandAiDiagnosisAdapter implements AiDiagnosisPort {
  constructor(private readonly options: CommandAiAdapterOptions) {}
  async diagnose(bundle: IncidentEvidenceBundle): Promise<Omit<AiDiagnosis, "diagnosisId" | "bundleId" | "incidentId" | "createdAt">> {
    return await runJsonCommand(this.options, {
      contract: "flerdvision.ai-diagnosis.v1",
      instruction: "Return JSON only. Diagnose the incident using only the sanitized bundle. Never request secrets, bypass authentication/challenges, switch accounts, override policy/copyright warnings, or authorize retry of an uncertain publication.",
      bundle
    });
  }
}

export class CommandAiRepairProposalAdapter implements AiRepairProposalPort {
  constructor(private readonly options: CommandAiAdapterOptions) {}
  async propose(bundle: IncidentEvidenceBundle, diagnosis: AiDiagnosis): Promise<Omit<RepairProposal, "proposalId" | "diagnosisId" | "incidentId" | "createdAt" | "changedFiles">> {
    return await runJsonCommand(this.options, {
      contract: "flerdvision.ai-repair-proposal.v1",
      instruction: "Return JSON only. Produce one narrow unified git diff plus regression tests. Do not touch safety, verification/reconciliation, operations kill-switch, storage, credentials, runtime profiles, final-publish semantics, CAPTCHA/2FA/authentication logic, or customer data.",
      bundle,
      diagnosis
    });
  }
}
