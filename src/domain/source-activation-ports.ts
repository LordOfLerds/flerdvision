export type SourceActivationOperationalState = "NOT_REQUIRED" | "MISSING_BASELINE" | "CAPTURED" | "MISCONFIGURED";

export interface SourceActivationStatus {
  laneId:string;
  mode?:string;
  state:SourceActivationOperationalState;
  baselineCount?:number;
  capturedAt?:string;
  reason?:string;
}

export interface SourceActivationBaselinePreview {
  laneId:string;
  cursorFingerprint:string;
  observedCount:number;
  sampleFileNames:readonly string[];
  snapshotFingerprint:string;
  previewedAt:string;
}

export interface SourceActivationCommandPort {
  status(laneId:string):SourceActivationStatus;
  previewBaseline(laneId:string,now:string):Promise<SourceActivationBaselinePreview>;
  /** expectedSnapshotFingerprint makes Preview -> Confirm fail closed if the folder changed in-between. */
  captureBaseline(laneId:string,now:string,expectedSnapshotFingerprint?:string):Promise<SourceActivationStatus>;
}
