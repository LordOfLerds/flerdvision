import type { QualificationChecklist } from "../application/release-qualification.js";
import type { WorkspaceQualificationSyncReport } from "../application/workspace-qualification-sync.js";

export interface QualificationOperatorStatus {
  available:boolean;
  reason:string;
  runId?:string;
  checklist?:QualificationChecklist;
}

export interface QualificationOperatorPort {
  status():QualificationOperatorStatus;
  sync(now:string,operatorId:string):Promise<WorkspaceQualificationSyncReport>;
}
