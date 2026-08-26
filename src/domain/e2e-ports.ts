import type { Actor } from "./control-plane.js";
import type {
  E2EGateResult,
  E2EPublishPermit,
  E2EPublishPermitConsumption,
  HostPreflightResult,
  PrivateE2ERun
} from "./e2e.js";

export interface E2EStorePort {
  createOrGetE2ERun(run: PrivateE2ERun, actor: Actor): PrivateE2ERun;
  getE2ERun(runId: string): PrivateE2ERun | null;
  listE2ERuns(accountId?: string): readonly PrivateE2ERun[];
  setE2ERunStatus(runId: string, status: PrivateE2ERun["status"], at: string, actor: Actor, reason: string): PrivateE2ERun;
  recordE2EGateResult(result: E2EGateResult, actor: Actor): E2EGateResult;
  listE2EGateResults(runId: string): readonly E2EGateResult[];
  issueE2EPublishPermit(permit: E2EPublishPermit, actor: Actor): E2EPublishPermit;
  getE2EPublishPermit(permitId: string): E2EPublishPermit | null;
  consumeE2EPublishPermit(permitId: string, tokenHash: string, at: string, actor: Actor): E2EPublishPermitConsumption;
  getE2EPublishPermitConsumption(permitId: string): E2EPublishPermitConsumption | null;
}

export interface HostPreflightPort {
  check(now: string): Promise<HostPreflightResult>;
}
