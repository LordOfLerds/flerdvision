export type PublicationState =
  | "PLANNED"
  | "READY"
  | "SCHEDULED"
  | "PREPARING"
  | "PUBLISHING"
  | "VERIFYING"
  | "PUBLISH_UNCERTAIN"
  | "RETRY_WAIT"
  | "VERIFIED"
  | "BLOCKED"
  | "WAIVED";

const allowed: Readonly<Record<PublicationState, readonly PublicationState[]>> = {
  PLANNED: ["READY", "BLOCKED", "WAIVED"],
  READY: ["SCHEDULED", "BLOCKED", "WAIVED"],
  SCHEDULED: ["PREPARING", "BLOCKED", "WAIVED"],
  PREPARING: ["SCHEDULED", "PUBLISHING", "RETRY_WAIT", "BLOCKED", "WAIVED"],
  PUBLISHING: ["VERIFYING", "PUBLISH_UNCERTAIN", "RETRY_WAIT", "BLOCKED"],
  VERIFYING: ["VERIFIED", "PUBLISH_UNCERTAIN", "RETRY_WAIT", "BLOCKED"],
  PUBLISH_UNCERTAIN: ["VERIFYING", "BLOCKED", "WAIVED"],
  RETRY_WAIT: ["READY", "SCHEDULED", "BLOCKED", "WAIVED"],
  VERIFIED: [],
  BLOCKED: ["READY", "SCHEDULED", "WAIVED"],
  WAIVED: []
};

export class InvalidTransitionError extends Error {
  constructor(readonly from: PublicationState, readonly to: PublicationState) {
    super(`Invalid publication transition: ${from} -> ${to}`);
  }
}

export function canTransition(from: PublicationState, to: PublicationState): boolean {
  return allowed[from].includes(to);
}

export function transition(from: PublicationState, to: PublicationState): PublicationState {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
  return to;
}

export function isTerminal(state: PublicationState): boolean {
  return state === "VERIFIED" || state === "WAIVED";
}
