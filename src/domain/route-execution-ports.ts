import type { PlannedDelivery } from "./distribution.js";

export interface RouteExecutionQualificationDecision {
  allowed: boolean;
  reasons: readonly string[];
}

export interface RouteExecutionQualificationPort {
  evaluate(delivery: PlannedDelivery): RouteExecutionQualificationDecision;
  assertAllowed(delivery: PlannedDelivery): void;
}
