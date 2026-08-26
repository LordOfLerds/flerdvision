/**
 * The setup wizard's gate.
 *
 * Order is derived from durable facts, never from which page the operator happens to be on, so a
 * hand-crafted POST cannot skip a step that a later one depends on. The rule mirrors the release
 * promotion gate one level down: a stage is reachable only once its predecessor is genuinely done.
 */

export type SetupStep = "DRIVE" | "FOLDER" | "LOGIN" | "CHANNEL" | "LINK" | "READY";

/** What a guarded action needs before it may run. */
export type SetupPrerequisite = "NONE" | "DRIVE_CONNECTED" | "FOLDER_SELECTED" | "SESSION_DISCOVERED" | "CHANNEL_REGISTERED" | "SOURCE_BOUND";

export interface SetupFacts {
  driveConnected: boolean;
  /** Folder chosen in this pass but not yet bound to a channel. */
  folderSelected: boolean;
  /** A discovery result is held for the session opened in this pass. */
  sessionDiscovered: boolean;
  registeredAccounts: number;
  bindings: number;
}

export interface SetupProgress {
  facts: SetupFacts;
  currentStep: SetupStep;
  completed: readonly SetupStep[];
  /** True once at least one channel is fully wired; further channels may still be added. */
  ready: boolean;
}

export class SetupGateError extends Error {}

const ORDER: readonly SetupStep[] = ["DRIVE", "FOLDER", "LOGIN", "CHANNEL", "LINK", "READY"];

export function computeSetupProgress(facts: SetupFacts): SetupProgress {
  // Later evidence implies the earlier steps. Some facts are transient by design -- a discovery
  // result is consumed when its channel is confirmed -- so reading each step in isolation would
  // make a finished workspace appear to fall back to "log in again".
  const bound = facts.bindings > 0;
  const channelDone = bound || facts.registeredAccounts > 0;
  const loginDone = channelDone || facts.sessionDiscovered;
  const folderDone = bound || facts.folderSelected;
  const driveDone = folderDone || facts.driveConnected;

  const completed: SetupStep[] = [];
  if (driveDone) completed.push("DRIVE");
  if (folderDone) completed.push("FOLDER");
  if (loginDone) completed.push("LOGIN");
  if (channelDone) completed.push("CHANNEL");
  if (bound) completed.push("LINK", "READY");

  const currentStep = ORDER.find((step) => !completed.includes(step)) ?? "READY";
  return { facts, currentStep, completed, ready: bound };
}

export function satisfies(progress: SetupProgress, prerequisite: SetupPrerequisite): boolean {
  switch (prerequisite) {
    case "NONE": return true;
    case "DRIVE_CONNECTED": return progress.facts.driveConnected;
    case "FOLDER_SELECTED": return progress.facts.folderSelected;
    case "SESSION_DISCOVERED": return progress.facts.sessionDiscovered;
    case "CHANNEL_REGISTERED": return progress.facts.registeredAccounts > 0;
    case "SOURCE_BOUND": return progress.facts.bindings > 0;
  }
}

const EXPLANATION: Readonly<Record<SetupPrerequisite, string>> = {
  NONE: "",
  DRIVE_CONNECTED: "Connect Google Drive first (step 1).",
  FOLDER_SELECTED: "Pick a source folder first (step 2).",
  SESSION_DISCOVERED: "Log the channel in first (step 3).",
  CHANNEL_REGISTERED: "Confirm a channel from the session first (step 4).",
  SOURCE_BOUND: "Link the folder to a channel first (step 5)."
};

export function assertPrerequisite(progress: SetupProgress, prerequisite: SetupPrerequisite): void {
  if (!satisfies(progress, prerequisite)) {
    throw new SetupGateError(`BLOCKED: ${EXPLANATION[prerequisite]}`);
  }
}
