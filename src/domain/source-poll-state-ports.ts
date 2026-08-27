import type { SourcePollTrigger } from "./distribution-operations.js";

export interface SourcePollingRuntimeState {
  lastPollAt?:string;
  nextPollAt?:string;
  lastTrigger?:SourcePollTrigger;
  skippedCycles:number;
  updatedAt:string;
}

export interface SourcePollingStateStorePort {
  get():SourcePollingRuntimeState|null;
  put(state:SourcePollingRuntimeState):SourcePollingRuntimeState;
}
