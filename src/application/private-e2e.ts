import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Actor } from "../domain/control-plane.js";
import type { E2EStorePort } from "../domain/e2e-ports.js";
import type {
  E2EGateKind,
  E2EGateResult,
  E2EPublishPermit,
  PrivacyAttestation,
  PrivateE2ERun
} from "../domain/e2e.js";
import type { PublicationIntent } from "../domain/model.js";
import type { PublishContext } from "../domain/ports.js";

export class PrivateE2EPolicyError extends Error {}
export class E2EPermitError extends Error {}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

function stableId(prefix: string, source: string): string {
  return `${prefix}:${createHash("sha256").update(source).digest("hex").slice(0, 24)}`;
}

function latestGate(results: readonly E2EGateResult[], gate: E2EGateKind): E2EGateResult | null {
  const matches = results.filter((item) => item.gate === gate);
  return matches.length ? matches[matches.length - 1]! : null;
}

export class PrivateE2EPolicy {
  constructor(private readonly minimumPrepareOnlyPasses = 3) {}

  assertPrivacy(attestation: PrivacyAttestation, zeroViewerRequired: boolean): void {
    if (!attestation.testMediaOnly) throw new PrivateE2EPolicyError("Private E2E may use test media only");
    if (!zeroViewerRequired) return;
    if (!attestation.accountPrivate) throw new PrivateE2EPolicyError("Zero-viewer E2E requires a private test account");
    if (attestation.approvedFollowers !== 0) throw new PrivateE2EPolicyError("Zero-viewer E2E requires zero approved followers");
    if (!attestation.contactsSyncOff) throw new PrivateE2EPolicyError("Zero-viewer E2E requires contacts sync to be off");
    if (!attestation.crossPostingOff) throw new PrivateE2EPolicyError("Zero-viewer E2E requires cross-posting to be off");
  }

  assertPublishReady(run: PrivateE2ERun, gates: readonly E2EGateResult[], intent: PublicationIntent, context: PublishContext): void {
    if (run.status !== "ACTIVE") throw new PrivateE2EPolicyError(`E2E run must be ACTIVE, got ${run.status}`);
    if (run.accountId !== intent.accountId || run.platform !== intent.platform) throw new PrivateE2EPolicyError("E2E run does not match publication intent account/platform");
    if (run.releaseSha !== context.releaseSha) throw new PrivateE2EPolicyError("E2E run release SHA does not match publish context");
    if (context.mode !== "test_account") throw new PrivateE2EPolicyError("Private E2E final action requires test_account mode");
    if (!context.allowFinalPublish) throw new PrivateE2EPolicyError("Final publish hard gate is disabled");
    if (!context.allowedAccountIds.has(intent.accountId)) throw new PrivateE2EPolicyError("Test account is not in final-publish allowlist");

    for (const gate of ["HOST_PREFLIGHT", "SESSION_HEALTH", "IDENTITY_GUARD", "UI_CALIBRATION", "PRIVACY_ATTESTATION", "FINAL_ACTION_CALIBRATION"] as const) {
      const result = latestGate(gates, gate);
      if (!result || result.status !== "PASS") throw new PrivateE2EPolicyError(`Required E2E gate is not PASS: ${gate}`);
    }
    const preparePasses = gates.filter((item) => item.gate === "PREPARE_ONLY_REPLAY" && item.status === "PASS").length;
    if (preparePasses < this.minimumPrepareOnlyPasses) {
      throw new PrivateE2EPolicyError(`Private publish requires at least ${this.minimumPrepareOnlyPasses} successful prepare-only replays; got ${preparePasses}`);
    }
  }
}

export interface StartE2ERunParams {
  runId: string;
  accountId: string;
  platform: PrivateE2ERun["platform"];
  releaseSha: string;
  now: string;
  operatorId: string;
  zeroViewerRequired?: boolean;
  note?: string;
}

export class PrivateE2ERunService {
  constructor(private readonly store: E2EStorePort, private readonly policy = new PrivateE2EPolicy()) {}

  start(params: StartE2ERunParams, actor: Actor): PrivateE2ERun {
    const run: PrivateE2ERun = {
      runId: params.runId,
      accountId: params.accountId,
      platform: params.platform,
      releaseSha: params.releaseSha,
      createdAt: new Date(params.now).toISOString(),
      createdBy: params.operatorId,
      status: "ACTIVE",
      testMediaOnly: true,
      zeroViewerRequired: params.zeroViewerRequired ?? true,
      ...(params.note ? { note: params.note } : {})
    };
    return this.store.createOrGetE2ERun(run, actor);
  }

  recordGate(params: Omit<E2EGateResult, "gateResultId">, actor: Actor): E2EGateResult {
    const gateResultId = stableId("e2e-gate", `${params.runId}|${params.gate}|${params.checkedAt}|${params.checkedBy}|${params.summary}`);
    return this.store.recordE2EGateResult({ ...params, gateResultId }, actor);
  }

  attestPrivacy(runId: string, attestation: PrivacyAttestation, now: string, operatorId: string, actor: Actor): E2EGateResult {
    const run = this.store.getE2ERun(runId);
    if (!run) throw new PrivateE2EPolicyError(`Unknown E2E run: ${runId}`);
    try {
      this.policy.assertPrivacy(attestation, run.zeroViewerRequired);
      return this.recordGate({ runId, gate: "PRIVACY_ATTESTATION", status: "PASS", checkedAt: now, checkedBy: operatorId, summary: "private-test-account visibility attestation passed", artifactRefs: [], details: { ...attestation } }, actor);
    } catch (error) {
      const summary = error instanceof Error ? error.message : String(error);
      this.recordGate({ runId, gate: "PRIVACY_ATTESTATION", status: "FAIL", checkedAt: now, checkedBy: operatorId, summary, artifactRefs: [], details: { ...attestation } }, actor);
      throw error;
    }
  }
}

export interface IssuedE2EPermit {
  permit: E2EPublishPermit;
  token: string;
}

export class E2EPublishPermitService {
  constructor(private readonly store: E2EStorePort, private readonly policy = new PrivateE2EPolicy()) {}

  issue(params: {
    runId: string;
    intent: PublicationIntent;
    context: PublishContext;
    now: string;
    operatorId: string;
    ttlSeconds?: number;
  }, actor: Actor): IssuedE2EPermit {
    const run = this.store.getE2ERun(params.runId);
    if (!run) throw new E2EPermitError(`Unknown E2E run: ${params.runId}`);
    const gates = this.store.listE2EGateResults(params.runId);
    this.policy.assertPublishReady(run, gates, params.intent, params.context);
    const ttl = params.ttlSeconds ?? 300;
    if (!Number.isInteger(ttl) || ttl < 30 || ttl > 600) throw new E2EPermitError("Permit TTL must be between 30 and 600 seconds");
    const token = randomBytes(32).toString("base64url");
    const issuedAt = new Date(params.now).toISOString();
    const permit: E2EPublishPermit = {
      permitId: stableId("e2e-permit", `${params.runId}|${params.intent.intentId}|${issuedAt}|${randomBytes(8).toString("hex")}`),
      runId: params.runId,
      intentId: params.intent.intentId,
      accountId: params.intent.accountId,
      releaseSha: params.context.releaseSha,
      issuedAt,
      expiresAt: new Date(new Date(issuedAt).getTime() + ttl * 1000).toISOString(),
      issuedBy: params.operatorId,
      tokenHash: hashToken(token)
    };
    return { permit: this.store.issueE2EPublishPermit(permit, actor), token };
  }

  consume(params: {
    permitId: string;
    token: string;
    runId: string;
    intent: PublicationIntent;
    context: PublishContext;
    now: string;
    workerId: string;
  }, actor: Actor): void {
    const permit = this.store.getE2EPublishPermit(params.permitId);
    if (!permit) throw new E2EPermitError("Unknown E2E publish permit");
    if (permit.runId !== params.runId || permit.intentId !== params.intent.intentId || permit.accountId !== params.intent.accountId) throw new E2EPermitError("E2E publish permit scope mismatch");
    if (permit.releaseSha !== params.context.releaseSha) throw new E2EPermitError("E2E publish permit release SHA mismatch");
    const now = new Date(params.now).toISOString();
    if (new Date(now).getTime() > new Date(permit.expiresAt).getTime()) throw new E2EPermitError("E2E publish permit expired");
    const supplied = hashToken(params.token);
    if (!sameHash(supplied, permit.tokenHash)) throw new E2EPermitError("E2E publish permit token is invalid");
    this.store.consumeE2EPublishPermit(permit.permitId, supplied, now, { ...actor, id: params.workerId });
  }
}
