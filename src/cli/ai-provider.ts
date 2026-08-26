import { readFileSync } from "node:fs";
import { aiProviderPreflight } from "../application/ai-provider.js";
import type { AiProviderConfig, AiProviderMode } from "../domain/ai-provider.js";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function parseConfig(value: unknown): AiProviderConfig {
  if (!value || typeof value !== "object") throw new Error("AI provider config must be an object");
  const item = value as Record<string, unknown>;
  const modes = new Set<AiProviderMode>(["disabled", "claude_subscription_cli", "codex_chatgpt_cli", "anthropic_api", "openai_api"]);
  if (typeof item.mode !== "string" || !modes.has(item.mode as AiProviderMode)) throw new Error("Invalid AI provider mode");
  if (typeof item.enabled !== "boolean") throw new Error("AI provider enabled must be boolean");
  const config: AiProviderConfig = { mode: item.mode as AiProviderMode, enabled: item.enabled };
  if (typeof item.wrapperCommand === "string") Object.assign(config, { wrapperCommand: item.wrapperCommand });
  if (Array.isArray(item.wrapperArgs) && item.wrapperArgs.every((entry) => typeof entry === "string")) Object.assign(config, { wrapperArgs: item.wrapperArgs as string[] });
  if (typeof item.timeoutMs === "number") Object.assign(config, { timeoutMs: item.timeoutMs });
  return config;
}

const path = arg("--config") ?? "config/ai-provider.example.json";
try {
  const config = parseConfig(JSON.parse(readFileSync(path, "utf8")) as unknown);
  const result = aiProviderPreflight(config);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ready) process.exitCode = 2;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
