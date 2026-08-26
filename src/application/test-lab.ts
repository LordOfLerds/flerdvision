import type { FixedTestRunnerPort } from "../domain/workspace-ports.js";
import type { SetupPrerequisite, SetupProgress } from "./setup-progress.js";
import { assertPrerequisite } from "./setup-progress.js";

export interface TestLabCase {
  testId: string;
  label: string;
  risk: "SAFE_LOCAL" | "PREPARE_ONLY" | "LIVE_SECRET";
  description: string;
  /**
   * What must be wired before this test may run. The three local tests need nothing: gating them
   * behind Drive and an account would buy no safety and would leave a fresh host unable to prove
   * it is healthy. Tests that touch a real surface declare their prerequisite here.
   */
  requires: SetupPrerequisite;
}

export const SELF_SERVICE_TEST_CATALOG: readonly TestLabCase[] = [
  { testId: "core", label: "Core test suite", risk: "SAFE_LOCAL", description: "Build and all repository regression tests.", requires: "NONE" },
  { testId: "w8-harness", label: "Private E2E harness", risk: "SAFE_LOCAL", description: "W8 safety, campaign and one-shot permit tests.", requires: "NONE" },
  { testId: "host-preflight", label: "Host preflight", risk: "SAFE_LOCAL", description: "Node, Chromium, private runtime directories, timezone and final-publish default.", requires: "NONE" }
] as const;

export class TestLabService {
  constructor(private readonly runner: FixedTestRunnerPort, private readonly cwd: string) {}
  catalog(): readonly TestLabCase[] { return SELF_SERVICE_TEST_CATALOG; }
  async run(testId: string, progress?: SetupProgress): Promise<{ passed: boolean; summary: string; artifactRefs: readonly string[] }> {
    const test = SELF_SERVICE_TEST_CATALOG.find((item) => item.testId === testId);
    if (!test) throw new Error(`Unknown self-service test: ${testId}`);
    if (!this.runner.supportedTests().includes(testId)) throw new Error(`Test runner does not support: ${testId}`);
    if (test.requires !== "NONE") {
      if (!progress) throw new Error(`Test ${testId} requires setup progress to be evaluated`);
      assertPrerequisite(progress, test.requires);
    }
    return await this.runner.run(testId, this.cwd);
  }
}
