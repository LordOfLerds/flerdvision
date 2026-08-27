import { spawnSync } from "node:child_process";
import type { UiLocator } from "../../domain/platform-ui.js";
import type { SurfaceAgentPort, SurfaceAgentProposal, SurfaceAgentRequest } from "../../domain/surface-agent.js";

export class SurfaceAgentProtocolError extends Error {}

const IRREVERSIBLE_CLICK_LABEL = /^(?:share|teilen|publish|veröffentlichen|post|posten|save|speichern|schedule|planen|submit|senden|done|fertig)$/i;
const DEFAULT_AGENT_ENV = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "TERM",
  "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "CLAUDE_CONFIG_DIR"
] as const;
const DENIED_AGENT_ENV = /(?:COOKIE|SESSION|PASSWORD|PASSWD|SECRET|TOKEN|API_KEY|AUTHORIZATION|CREDENTIAL|REFRESH|WEBHOOK|PRIVATE_KEY)/i;

/**
 * Build the minimal environment visible to Claude. Runtime credentials are denied even when an
 * operator accidentally asks to forward them. Account-based Claude Code auth is read through its
 * config directory, not by exposing Flerdvision's Drive, browser, webhook or publish secrets.
 */
export function surfaceAgentChildEnvironment(env: Record<string, string | undefined>): Record<string, string> {
  const requested = (env.FLERDVISION_SURFACE_AGENT_FORWARD_ENV ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const names = new Set<string>([...DEFAULT_AGENT_ENV, ...requested]);
  const child: Record<string, string> = {};
  for (const name of names) {
    if (DENIED_AGENT_ENV.test(name)) {
      if (requested.includes(name)) throw new SurfaceAgentProtocolError(`Refusing to forward sensitive surface-agent environment variable: ${name}`);
      continue;
    }
    const value = env[name];
    if (typeof value === "string") child[name] = value;
  }
  return child;
}

function locator(value: unknown, path: string): UiLocator {
  if (!value || typeof value !== "object") throw new SurfaceAgentProtocolError(`${path} must be an object`);
  const item = value as Record<string, unknown>;
  if (item.kind !== "css" && item.kind !== "text" && item.kind !== "role" && item.kind !== "label") throw new SurfaceAgentProtocolError(`${path}.kind is invalid`);
  if (typeof item.value !== "string" || !item.value.trim() || item.value.length > 500) throw new SurfaceAgentProtocolError(`${path}.value is invalid`);
  if (item.kind === "css" && (item.value.trim() === "*" || item.value.includes("javascript:"))) throw new SurfaceAgentProtocolError(`${path}.value is unsafe`);
  if (item.role !== undefined && typeof item.role !== "string") throw new SurfaceAgentProtocolError(`${path}.role must be a string`);
  if (item.exact !== undefined && typeof item.exact !== "boolean") throw new SurfaceAgentProtocolError(`${path}.exact must be boolean`);
  return {
    kind: item.kind,
    value: item.value.trim(),
    ...(typeof item.role === "string" ? { role: item.role } : {}),
    ...(typeof item.exact === "boolean" ? { exact: item.exact } : {})
  };
}

function assertProposalSafe(request: SurfaceAgentRequest, locators: readonly UiLocator[]): void {
  if (request.action !== "CLICK" || request.stepKey === "FINAL_ACTION") return;
  for (const item of locators) {
    if (item.kind === "css") {
      throw new SurfaceAgentProtocolError(`Surface agent may not propose opaque CSS for reversible CLICK step ${request.stepKey}`);
    }
    const semantic = item.value.trim().replace(/\s+/g, " ");
    if (IRREVERSIBLE_CLICK_LABEL.test(semantic)) {
      throw new SurfaceAgentProtocolError(`Surface agent proposed an irreversible label for reversible step ${request.stepKey}: ${semantic}`);
    }
  }
}

function proposal(value: unknown, request: SurfaceAgentRequest): SurfaceAgentProposal {
  if (!value || typeof value !== "object") throw new SurfaceAgentProtocolError("Surface agent output must be an object");
  const item = value as Record<string, unknown>;
  if (item.schemaVersion !== 1) throw new SurfaceAgentProtocolError("Surface agent schemaVersion must be 1");
  if (item.stepKey !== request.stepKey) throw new SurfaceAgentProtocolError("Surface agent stepKey does not match the request");
  if (!Array.isArray(item.locators) || item.locators.length === 0 || item.locators.length > 8) throw new SurfaceAgentProtocolError("Surface agent locators must contain 1..8 entries");
  if (typeof item.rationale !== "string" || !item.rationale.trim()) throw new SurfaceAgentProtocolError("Surface agent rationale is required");
  const locators = item.locators.map((entry, index) => locator(entry, `locators[${index}]`));
  assertProposalSafe(request, locators);
  return { schemaVersion: 1, stepKey: request.stepKey, locators, rationale: item.rationale.trim() };
}

export interface CommandSurfaceAgentOptions {
  command: string;
  args?: readonly string[];
  timeoutMs?: number;
  cwd?: string;
  env?: Record<string, string | undefined>;
}

/**
 * Adapter for Claude or another local reasoning process. It receives only a sanitized semantic
 * snapshot and may propose locators; it can never click, receive cookies, or authorize publish.
 */
export class CommandSurfaceAgent implements SurfaceAgentPort {
  constructor(private readonly options: CommandSurfaceAgentOptions) {
    if (!options.command.trim()) throw new SurfaceAgentProtocolError("Surface agent command is required");
  }

  async propose(request: SurfaceAgentRequest): Promise<SurfaceAgentProposal | null> {
    const run = spawnSync(this.options.command, this.options.args ?? [], {
      ...(this.options.cwd ? { cwd: this.options.cwd } : {}),
      input: JSON.stringify(request),
      encoding: "utf8",
      timeout: this.options.timeoutMs ?? 120_000,
      maxBuffer: 2 * 1024 * 1024,
      env: surfaceAgentChildEnvironment(this.options.env ?? process.env)
    });
    if (run.error) throw new SurfaceAgentProtocolError(`Surface agent failed to start: ${run.error.message}`);
    if (run.status !== 0) throw new SurfaceAgentProtocolError(`Surface agent exited ${String(run.status)}: ${run.stderr.slice(0, 1000)}`);
    const text = run.stdout.trim();
    if (!text) return null;
    try { return proposal(JSON.parse(text) as unknown, request); }
    catch (error) {
      if (error instanceof SurfaceAgentProtocolError) throw error;
      throw new SurfaceAgentProtocolError(`Surface agent returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export function commandSurfaceAgentFromEnv(env: Record<string, string | undefined> = process.env): CommandSurfaceAgent | null {
  const command = env.FLERDVISION_SURFACE_AGENT_COMMAND?.trim();
  if (!command) return null;
  let args: readonly string[] = [];
  if (env.FLERDVISION_SURFACE_AGENT_ARGS_JSON) {
    const parsed = JSON.parse(env.FLERDVISION_SURFACE_AGENT_ARGS_JSON) as unknown;
    if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) throw new SurfaceAgentProtocolError("FLERDVISION_SURFACE_AGENT_ARGS_JSON must be a JSON string array");
    args = parsed as string[];
  }
  const timeoutMs = Number(env.FLERDVISION_SURFACE_AGENT_TIMEOUT_MS ?? "120000");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600_000) throw new SurfaceAgentProtocolError("FLERDVISION_SURFACE_AGENT_TIMEOUT_MS must be an integer from 1000 to 600000");
  return new CommandSurfaceAgent({ command, args, timeoutMs, env });
}
