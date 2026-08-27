export type SourceActivationOperationalState = "NOT_REQUIRED" | "MISSING_BASELINE" | "CAPTURED" | "MISCONFIGURED";

export interface SourceActivationStatus {
  laneId:string;
  mode?:string;
  state:SourceActivationOperationalState;
  baselineCount?:number;
  capturedAt?:string;
  reason?:string;
}

export interface SourceActivationCommandPort {
  status(laneId:string):SourceActivationStatus;
  captureBaseline(laneId:string,now:string):Promise<SourceActivationStatus>;
}
