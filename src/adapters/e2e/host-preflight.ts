import { accessSync, constants, mkdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { HostPreflightPort } from "../../domain/e2e-ports.js";
import type { HostPreflightCheck, HostPreflightResult } from "../../domain/e2e.js";

export interface NodeHostPreflightConfig {
  chromiumExecutablePath: string;
  runtimeDir: string;
  profilesDir: string;
  evidenceDir: string;
  expectedTimezone?: string;
  minimumNodeMajor?: number;
}

function checkExecutable(path: string): HostPreflightCheck {
  try {
    accessSync(path, constants.X_OK);
    return { name: "chromium_executable", passed: true, detail: `${path} executable` };
  } catch {
    return { name: "chromium_executable", passed: false, detail: `${path} is missing or not executable` };
  }
}

function privateDirectory(name: string, path: string): HostPreflightCheck {
  try {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    const mode = statSync(path).mode & 0o777;
    const secure = (mode & 0o077) === 0;
    return { name, passed: secure, detail: `${resolve(path)} mode=${mode.toString(8)}${secure ? "" : " (group/other access must be removed)"}` };
  } catch (error) {
    return { name, passed: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

export class NodeHostPreflightAdapter implements HostPreflightPort {
  constructor(private readonly config: NodeHostPreflightConfig) {}

  async check(now: string): Promise<HostPreflightResult> {
    const checks: HostPreflightCheck[] = [];
    const minimumNodeMajor = this.config.minimumNodeMajor ?? 22;
    const actualNodeMajor = Number(process.versions.node.split(".")[0]);
    checks.push({ name: "node_version", passed: Number.isInteger(actualNodeMajor) && actualNodeMajor >= minimumNodeMajor, detail: `node=${process.versions.node}; required>=${minimumNodeMajor}` });
    checks.push(checkExecutable(this.config.chromiumExecutablePath));
    checks.push(privateDirectory("runtime_directory", this.config.runtimeDir));
    checks.push(privateDirectory("profiles_directory", this.config.profilesDir));
    checks.push(privateDirectory("evidence_directory", this.config.evidenceDir));
    const expectedTimezone = this.config.expectedTimezone ?? "Europe/Vienna";
    const timezone = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    checks.push({ name: "timezone", passed: timezone === expectedTimezone, detail: `timezone=${timezone}; expected=${expectedTimezone}` });
    checks.push({ name: "final_publish_default", passed: process.env.ALLOW_FINAL_PUBLISH !== "true", detail: process.env.ALLOW_FINAL_PUBLISH === "true" ? "ALLOW_FINAL_PUBLISH is globally enabled during preflight" : "final-publish hard gate is disabled by default" });
    return { checkedAt: new Date(now).toISOString(), ready: checks.every((item) => item.passed), checks };
  }
}
