import type { FixedTestRunnerPort } from "../domain/workspace-ports.js";

export interface TestLabCase {
  testId: string;
  label: string;
  risk: "SAFE_LOCAL" | "PREPARE_ONLY" | "LIVE_SECRET";
  description: string;
}

export const SELF_SERVICE_TEST_CATALOG: readonly TestLabCase[] = [
  { testId: "core", label: "Core test suite", risk: "SAFE_LOCAL", description: "Build and all repository regression tests." },
  { testId: "w8-harness", label: "Private E2E harness", risk: "SAFE_LOCAL", description: "W8 safety, campaign and one-shot permit tests." },
  { testId: "host-preflight", label: "Host preflight", risk: "SAFE_LOCAL", description: "Node, Chromium, private runtime directories, timezone and final-publish default." }
] as const;

export class TestLabService {
  constructor(private readonly runner: FixedTestRunnerPort, private readonly cwd: string) {}
  catalog(): readonly TestLabCase[] { return SELF_SERVICE_TEST_CATALOG; }
  async run(testId: string): Promise<{ passed: boolean; summary: string; artifactRefs: readonly string[] }> {
    const test = SELF_SERVICE_TEST_CATALOG.find((item) => item.testId === testId);
    if (!test) throw new Error(`Unknown self-service test: ${testId}`);
    if (!this.runner.supportedTests().includes(testId)) throw new Error(`Test runner does not support: ${testId}`);
    return await this.runner.run(testId, this.cwd);
  }
}
