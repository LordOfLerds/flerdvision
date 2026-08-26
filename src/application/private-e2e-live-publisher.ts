import { createHash } from "node:crypto";
import type { Actor } from "../domain/control-plane.js";
import type { PublicationIntentStorePort } from "../domain/control-plane-ports.js";
import type { PublicationIntent, PublishAttempt, VerificationEvidence } from "../domain/model.js";
import type { PublishContext } from "../domain/ports.js";
import type { FinalActionInvokerPort, PublishAttemptStorePort } from "../domain/verification-ports.js";
import type { PreparedPlatformSession } from "./platform-preparation.js";
import { PlatformPreparationCoordinator } from "./platform-preparation.js";
import { BrowserDomUiDriver } from "../adapters/browser/dom-ui-driver.js";
import { DurableFinalActionService, type DurableFinalActionOutcome } from "./durable-final-action.js";
import { E2EPublishPermitService } from "./private-e2e.js";
import type { E2EStorePort } from "../domain/e2e-ports.js";
import type { OperationalPublishGatePort } from "../domain/operations-ports.js";

export class LiveE2ESessionError extends Error {}

type LivePrepareStore = PublicationIntentStorePort & PublishAttemptStorePort;

function evidenceId(intentId: string, attemptId: string, at: string): string {
  return `evidence:${createHash("sha256").update(`${intentId}|${attemptId}|${at}|final-click`).digest("hex").slice(0, 24)}`;
}

export class RetainedPreparedSessionRegistry {
  private readonly sessions = new Map<string, PreparedPlatformSession>();

  add(prepared: PreparedPlatformSession): void {
    if (this.sessions.has(prepared.attempt.attemptId)) throw new LiveE2ESessionError(`Prepared session already exists for ${prepared.attempt.attemptId}`);
    this.sessions.set(prepared.attempt.attemptId, prepared);
  }

  get(attemptId: string): PreparedPlatformSession {
    const session = this.sessions.get(attemptId);
    if (!session) throw new LiveE2ESessionError(`No retained prepared session for ${attemptId}`);
    return session;
  }

  async close(attemptId: string): Promise<void> {
    const session = this.sessions.get(attemptId);
    if (!session) return;
    this.sessions.delete(attemptId);
    await session.close();
  }

  async closeAll(): Promise<void> {
    const ids = [...this.sessions.keys()];
    for (const id of ids) await this.close(id);
  }
}

export class LiveE2EPreparationService {
  constructor(
    private readonly store: LivePrepareStore,
    private readonly coordinator: PlatformPreparationCoordinator,
    private readonly registry: RetainedPreparedSessionRegistry
  ) {}

  async prepare(intentId: string, now: string, actor: Actor): Promise<PublishAttempt> {
    const record = this.store.getIntent(intentId);
    if (!record) throw new LiveE2ESessionError(`Unknown publication intent: ${intentId}`);
    if (record.state !== "SCHEDULED") throw new LiveE2ESessionError(`Live E2E prepare requires SCHEDULED intent, got ${record.state}`);
    this.store.transitionIntent(intentId, "PREPARING", now, actor, "private_e2e_prepare_started");
    try {
      const prepared = await this.coordinator.open(record.intent);
      try {
        const storedAttempt = this.store.recordPreparedAttempt(prepared.attempt, actor);
        this.registry.add(prepared);
        return storedAttempt;
      } catch (error) {
        await prepared.close();
        throw error;
      }
    } catch (error) {
      const current = this.store.getIntent(intentId);
      if (current?.state === "PREPARING") {
        this.store.transitionIntent(intentId, "BLOCKED", new Date().toISOString(), actor, `private_e2e_prepare_failed:${error instanceof Error ? error.message : String(error)}`);
      }
      throw error;
    }
  }
}

export class RetainedSessionFinalActionInvoker implements FinalActionInvokerPort {
  constructor(private readonly registry: RetainedPreparedSessionRegistry, private readonly now: () => string = () => new Date().toISOString()) {}

  async invoke(intent: PublicationIntent, attempt: PublishAttempt): Promise<{ invokedAt: string; finishedAt: string; evidence: readonly VerificationEvidence[] }> {
    const prepared = this.registry.get(attempt.attemptId);
    if (prepared.attempt.intentId !== intent.intentId) throw new LiveE2ESessionError("Retained session intent mismatch");
    if (prepared.identityId !== attempt.browserIdentityId) throw new LiveE2ESessionError("Retained session browser identity mismatch");
    const invokedAt = new Date(this.now()).toISOString();
    try {
      const driver = new BrowserDomUiDriver(prepared.session);
      const descriptor = await driver.clickIrreversible(prepared.adapter.finalActionLocators(intent), 10_000);
      const finishedAt = new Date(this.now()).toISOString();
      return {
        invokedAt,
        finishedAt,
        evidence: [{
          evidenceId: evidenceId(intent.intentId, attempt.attemptId, invokedAt), intentId: intent.intentId, attemptId: attempt.attemptId,
          kind: "ui_receipt", observedAt: finishedAt, positive: true, locator: descriptor,
          note: "final UI action was invoked on the retained prepared browser session; this is not by itself proof of publication"
        }]
      };
    } finally {
      await this.registry.close(attempt.attemptId);
    }
  }
}

export class PrivateE2EFinalActionController {
  private readonly durable: DurableFinalActionService;

  constructor(
    private readonly e2eStore: E2EStorePort & PublicationIntentStorePort,
    finalActionStore: ConstructorParameters<typeof DurableFinalActionService>[0],
    invoker: FinalActionInvokerPort,
    private readonly permitService: E2EPublishPermitService,
    now: () => string = () => new Date().toISOString(),
    operationalGate?: OperationalPublishGatePort
  ) {
    this.durable = new DurableFinalActionService(finalActionStore, invoker, now, operationalGate);
  }

  async execute(params: {
    runId: string;
    permitId: string;
    permitToken: string;
    intentId: string;
    attemptId: string;
    context: PublishContext;
    workerId: string;
    now: string;
    actor: Actor;
  }): Promise<DurableFinalActionOutcome> {
    const run = this.e2eStore.getE2ERun(params.runId);
    if (!run) throw new LiveE2ESessionError(`Unknown E2E run: ${params.runId}`);
    // Resolve through the E2E permit scope first. The permit is one-shot and is
    // consumed before entering the durable irreversible boundary. A crash in
    // between is fail-safe: another human permit is required, but no blind retry occurs.
    const permit = this.e2eStore.getE2EPublishPermit(params.permitId);
    if (!permit) throw new LiveE2ESessionError(`Unknown E2E permit: ${params.permitId}`);
    const intentRecord = this.e2eStore.getIntent(params.intentId);
    if (!intentRecord) throw new LiveE2ESessionError(`Unknown publication intent: ${params.intentId}`);
    this.permitService.consume({
      permitId: params.permitId, token: params.permitToken, runId: params.runId, intent: intentRecord.intent,
      context: params.context, now: params.now, workerId: params.workerId
    }, params.actor);
    return this.durable.execute(params.intentId, params.attemptId, params.context, params.actor);
  }
}
