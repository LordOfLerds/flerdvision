import type { DeliveryAggregate, SourceConnection, SourceDispositionPolicy } from "../domain/distribution.js";

export type SourceDispositionDecision =
  | { action: "NOOP"; reason: string }
  | { action: "RECORD_ONLY"; reason: string }
  | { action: "WRITE_METADATA"; reason: string }
  | { action: "WRITE_SIDECAR"; reason: string }
  | { action: "MOVE"; destinationRef: string; reason: string }
  | { action: "MANUAL_REVIEW"; reason: string };

export function decideSourceDisposition(aggregate: DeliveryAggregate, policy: SourceDispositionPolicy): SourceDispositionDecision {
  if (aggregate.status === "PENDING") return { action: "NOOP", reason: "Required deliveries are not terminal yet." };
  if (aggregate.status === "PARTIAL") return policy.leavePartialUntouched
    ? { action: "NOOP", reason: "Partial delivery leaves original source media untouched." }
    : { action: "MANUAL_REVIEW", reason: "Partial delivery requires an explicit source disposition decision." };
  if (aggregate.status === "BLOCKED") return policy.leaveBlockedUntouched
    ? { action: "NOOP", reason: "Blocked delivery leaves original source media untouched." }
    : { action: "MANUAL_REVIEW", reason: "Blocked delivery requires an explicit source disposition decision." };

  if (policy.mode === "database_only") return { action: "RECORD_ONLY", reason: "All required deliveries are complete; Drive/source remains unchanged by policy." };
  if (policy.mode === "drive_metadata") return { action: "WRITE_METADATA", reason: "All required deliveries are complete; write completion metadata only." };
  if (policy.mode === "sidecar") return { action: "WRITE_SIDECAR", reason: "All required deliveries are complete; write configured status sidecar." };
  if (!policy.completedDestinationRef) return { action: "MANUAL_REVIEW", reason: "move_on_complete has no completedDestinationRef and cannot mutate source safely." };
  return { action: "MOVE", destinationRef: policy.completedDestinationRef, reason: "All required deliveries are complete and explicit move_on_complete policy is configured." };
}

export function dispositionForConnection(aggregate: DeliveryAggregate, connection: SourceConnection): SourceDispositionDecision {
  if (!connection.enabled) return { action: "NOOP", reason: "Source connection is disabled." };
  return decideSourceDisposition(aggregate, connection.disposition);
}
