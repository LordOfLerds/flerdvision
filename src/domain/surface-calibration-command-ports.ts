import type { CalibrationActionMode, PlatformSurfaceContractStatus, SurfaceStepObservation } from "./platform-surface.js";

export interface SurfaceCalibrationStepStatus {
  stepKey:string;
  label:string;
  actionMode:CalibrationActionMode;
  required:boolean;
  observations:number;
  armed:boolean;
  specialCapture?:"FILE_INPUT";
}
export interface SurfaceCalibrationRouteStatus {
  routeId:string;
  accountId:string;
  postingProfileId:string;
  platform:string;
  format:string;
  browserOpen:boolean;
  contractStatus:"MISSING"|PlatformSurfaceContractStatus;
  contractId?:string;
  replayPasses:number;
  requiredReplays?:number;
  steps:readonly SurfaceCalibrationStepStatus[];
}

export interface SurfaceCalibrationCommandPort {
  status(routeId:string):SurfaceCalibrationRouteStatus;
  openBrowser(routeId:string,now:string):Promise<void>;
  closeBrowser(routeId:string):Promise<void>;
  armStep(routeId:string,stepKey:string):Promise<void>;
  captureStep(routeId:string,stepKey:string,now:string):Promise<SurfaceStepObservation>;
  buildRecordedContract(routeId:string,now:string):string;
}
