import type { PublicationIntent } from "../domain/model.js";
import type { OperationalPublishGatePort } from "../domain/operations-ports.js";
import type { KillSwitch, OperationalGateDecision } from "../domain/operations.js";
import type { SchedulePauseStorePort } from "../domain/operator-ports.js";
import { OperationalKillSwitchError } from "./operations.js";

/**
 * Turns the operator's persisted schedule pauses into an OperationalPublishGatePort so the due
 * worker's existing gate seam respects them: a paused account's due intents simply stay
 * SCHEDULED and unclaimed (DueWorkClaimer skips disallowed candidates) instead of burning to
 * BLOCKED. Blocking entries are surfaced in kill-switch shape purely for the shared decision
 * type; the reason prefix "operator_pause:" keeps them distinguishable from real kill switches.
 */
export class SchedulePauseGate implements OperationalPublishGatePort {
  constructor(private readonly store: SchedulePauseStorePort) {}

  evaluate(intent: PublicationIntent): OperationalGateDecision {
    const blocking: KillSwitch[] = this.store.listSchedulePauses()
      .filter((pause) => pause.scopeKey === "*" || pause.scopeKey === intent.accountId)
      .map((pause) => ({
        scopeType: pause.scopeKey === "*" ? "GLOBAL" : "ACCOUNT",
        scopeKey: pause.scopeKey,
        enabled: true,
        reason: `operator_pause:${pause.reason}`,
        updatedAt: pause.pausedAt,
        updatedBy: pause.pausedBy
      }));
    return { allowed: blocking.length === 0, blockingSwitches: blocking };
  }

  assertAllowed(intent: PublicationIntent): void {
    const decision = this.evaluate(intent);
    if (!decision.allowed) throw new OperationalKillSwitchError(decision);
  }
}

/**
 * ANDs several publish gates (kill switches + operator pauses) into the one gate slot the due
 * worker accepts. Every inner gate is always evaluated so the decision lists all blockers.
 */
export class CompositeOperationalPublishGate implements OperationalPublishGatePort {
  private readonly gates: readonly OperationalPublishGatePort[];

  constructor(gates: readonly OperationalPublishGatePort[]) {
    if (gates.length === 0) throw new Error("Composite publish gate requires at least one gate");
    this.gates = gates;
  }

  evaluate(intent: PublicationIntent): OperationalGateDecision {
    const decisions = this.gates.map((gate) => gate.evaluate(intent));
    const blockingSwitches = decisions.flatMap((decision) => decision.blockingSwitches);
    return { allowed: blockingSwitches.length === 0, blockingSwitches };
  }

  assertAllowed(intent: PublicationIntent): void {
    const decision = this.evaluate(intent);
    if (!decision.allowed) throw new OperationalKillSwitchError(decision);
  }
}
