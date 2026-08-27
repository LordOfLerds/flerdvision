/**
 * Setup gate. Step names retain LINK/SOURCE_BOUND as compatibility symbols for older UI/tests,
 * but new onboarding semantics are lane-based: LINK means a durable SourceLane exists, not that
 * an account owns one folder. Account-to-lane distribution is configured later in Programs.
 */
export type SetupStep = "DRIVE" | "FOLDER" | "LOGIN" | "CHANNEL" | "LINK" | "READY";
export type SetupPrerequisite = "NONE" | "DRIVE_CONNECTED" | "FOLDER_SELECTED" | "SESSION_DISCOVERED" | "CHANNEL_REGISTERED" | "SOURCE_BOUND";

export interface SetupFacts {
  driveConnected: boolean;
  folderSelected: boolean;
  sessionDiscovered: boolean;
  registeredAccounts: number;
  /** New canonical fact: persistent SourceLane count in distribution config. */
  sourceLanes?: number;
  /** Legacy compatibility only. New onboarding never creates ChannelSourceBinding. */
  bindings?: number;
}

export interface SetupProgress {
  facts: SetupFacts;
  currentStep: SetupStep;
  completed: readonly SetupStep[];
  /** Ready means source lane + at least one independently registered channel exist. */
  ready: boolean;
}

export class SetupGateError extends Error {}
const ORDER: readonly SetupStep[] = ["DRIVE", "FOLDER", "LOGIN", "CHANNEL", "LINK", "READY"];

export function computeSetupProgress(facts: SetupFacts): SetupProgress {
  const laneDone = (facts.sourceLanes ?? 0) > 0 || (facts.bindings ?? 0) > 0;
  const channelDone = facts.registeredAccounts > 0;
  const loginDone = channelDone || facts.sessionDiscovered;
  const folderDone = laneDone || facts.folderSelected;
  const driveDone = folderDone || facts.driveConnected;

  const completed: SetupStep[] = [];
  if (driveDone) completed.push("DRIVE");
  if (folderDone) completed.push("FOLDER");
  if (loginDone) completed.push("LOGIN");
  if (channelDone) completed.push("CHANNEL");
  if (laneDone) completed.push("LINK");
  if (laneDone && channelDone) completed.push("READY");

  const ready = laneDone && channelDone;
  const currentStep = ready ? "READY" : ORDER.find((step) => !completed.includes(step)) ?? "READY";
  return { facts, currentStep, completed, ready };
}

export function satisfies(progress: SetupProgress, prerequisite: SetupPrerequisite): boolean {
  switch (prerequisite) {
    case "NONE": return true;
    case "DRIVE_CONNECTED": return progress.facts.driveConnected;
    case "FOLDER_SELECTED": return progress.facts.folderSelected;
    case "SESSION_DISCOVERED": return progress.facts.sessionDiscovered;
    case "CHANNEL_REGISTERED": return progress.facts.registeredAccounts > 0;
    case "SOURCE_BOUND": return (progress.facts.sourceLanes ?? 0) > 0 || (progress.facts.bindings ?? 0) > 0;
  }
}

const EXPLANATION: Readonly<Record<SetupPrerequisite, string>> = {
  NONE: "",
  DRIVE_CONNECTED: "Connect a source first (step 1).",
  FOLDER_SELECTED: "Pick a source folder first (step 2).",
  SESSION_DISCOVERED: "Log the channel in first (step 3).",
  CHANNEL_REGISTERED: "Confirm a channel from the session first (step 4).",
  SOURCE_BOUND: "Persist the selected folder as a Source Lane first (step 5)."
};

export function assertPrerequisite(progress: SetupProgress, prerequisite: SetupPrerequisite): void {
  if (!satisfies(progress, prerequisite)) throw new SetupGateError(`BLOCKED: ${EXPLANATION[prerequisite]}`);
}
