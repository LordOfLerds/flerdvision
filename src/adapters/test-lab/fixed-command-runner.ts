import { spawnSync } from "node:child_process";
import type { FixedTestRunnerPort } from "../../domain/workspace-ports.js";

const COMMANDS: Readonly<Record<string, readonly string[]>> = {
  core: ["npm", "test"],
  "w8-harness": ["npm", "run", "test:w8"],
  "host-preflight": ["npm", "run", "e2e", "--", "preflight"]
};

export class FixedCommandTestRunner implements FixedTestRunnerPort {
  supportedTests(): readonly string[] { return Object.keys(COMMANDS); }
  async run(testId: string, cwd: string): Promise<{ passed: boolean; summary: string; artifactRefs: readonly string[] }> {
    const command = COMMANDS[testId]; if (!command) throw new Error(`Unsupported fixed test: ${testId}`);
    const result = spawnSync(command[0]!, command.slice(1), { cwd, encoding: "utf8", timeout: 180_000, maxBuffer: 2_000_000, env: { ...process.env, ALLOW_FINAL_PUBLISH: "false" } });
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
    const tail = output.split("\n").slice(-20).join("\n");
    return { passed: result.status === 0, summary: `${command.join(" ")} exit=${result.status ?? "null"}${tail ? `\n${tail}` : ""}`, artifactRefs: [] };
  }
}
