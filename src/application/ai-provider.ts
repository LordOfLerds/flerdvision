import { accessSync, constants } from "node:fs";
import { delimiter } from "node:path";
import type { AiProviderConfig, AiProviderPreflight } from "../domain/ai-provider.js";

function commandExists(command: string): boolean {
  if (command.includes("/")) {
    try { accessSync(command, constants.X_OK); return true; } catch { return false; }
  }
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    try { accessSync(`${dir}/${command}`, constants.X_OK); return true; } catch {}
  }
  return false;
}

export function aiProviderPreflight(config: AiProviderConfig, env: Record<string, string | undefined> = process.env): AiProviderPreflight {
  const checks: Array<{ name: string; passed: boolean; detail: string }> = [];
  if (!config.enabled || config.mode === "disabled") {
    checks.push({ name: "provider_disabled", passed: true, detail: "AI repair provider is disabled; deterministic incident handling remains active" });
    return { mode: config.mode, enabled: false, ready: true, checks };
  }
  const wrapper = config.wrapperCommand?.trim();
  checks.push({ name: "wrapper_configured", passed: Boolean(wrapper), detail: wrapper ? `wrapper=${wrapper}` : "wrapperCommand is required" });
  if (wrapper) checks.push({ name: "wrapper_executable", passed: commandExists(wrapper), detail: commandExists(wrapper) ? "wrapper executable found" : "wrapper executable not found on PATH" });

  if (config.mode === "anthropic_api") {
    checks.push({ name: "provider_credential", passed: Boolean(env.ANTHROPIC_API_KEY), detail: env.ANTHROPIC_API_KEY ? "ANTHROPIC_API_KEY present" : "ANTHROPIC_API_KEY missing" });
  } else if (config.mode === "openai_api") {
    checks.push({ name: "provider_credential", passed: Boolean(env.OPENAI_API_KEY), detail: env.OPENAI_API_KEY ? "OPENAI_API_KEY present" : "OPENAI_API_KEY missing" });
  } else {
    checks.push({ name: "subscription_auth", passed: true, detail: "subscription CLI authentication is checked by the provider wrapper at runtime; no social credentials are passed" });
  }
  return { mode: config.mode, enabled: true, ready: checks.every((item) => item.passed), checks };
}
