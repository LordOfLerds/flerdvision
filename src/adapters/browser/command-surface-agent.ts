import { spawnSync } from "node:child_process";
import type { UiLocator } from "../../domain/platform-ui.js";
import type { SurfaceAgentPort, SurfaceAgentProposal, SurfaceAgentRequest } from "../../domain/surface-agent.js";

export class SurfaceAgentProtocolError extends Error {}

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

function proposal(value: unknown, request: SurfaceAgentRequest): SurfaceAgentProposal {
  if (!value || typeof value !== "object") throw new SurfaceAgentProtocolError("Surface agent output must be an object");
  const item = value as Record<string, unknown>;
  if (item.schemaVersion !== 1) throw new SurfaceAgentProtocolError("Surface agent schemaVersion must be 1");
  if (item.stepKey !== request.stepKey) throw new SurfaceAgentProtocolError("Surface agent stepKey does not match the request");
  if (!Array.isArray(item.locators) || item.locators.length === 0 || item.locators.length > 8) throw new SurfaceAgentProtocolError("Surface agent locators must contain 1..8 entries");
  if (typeof item.rationale !== "string" || !item.rationale.trim()) throw new SurfaceAgentProtocolError("Surface agent rationale is required");
  return { schemaVersion: 1, stepKey: request.stepKey, locators: item.locators.map((entry, index) => locator(entry, `locators[${index}]`)), rationale: item.rationale.trim() };
}

export interface CommandSurfaceAgentOptions {
  command: string;
  args?: readonly string[];
  timeoutMs?: number;
  cwd?: string;
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
      env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
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
  return new CommandSurfaceAgent({ command, args, timeoutMs: Number(env.FLERDVISION_SURFACE_AGENT_TIMEOUT_MS ?? "120000") });
}
