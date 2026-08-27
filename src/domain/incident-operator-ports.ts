import type { KillSwitch, KillSwitchScopeType } from "./operations.js";

export interface IncidentOperatorCommandPort {
  acknowledge(incidentId:string,now:string,note?:string):void;
  resolve(incidentId:string,now:string,note:string):void;
  resumeIntent(incidentId:string,now:string,note:string):void;
  waiveIntent(incidentId:string,now:string,reason:string):void;
  listKillSwitches():readonly KillSwitch[];
  setKillSwitch(scopeType:KillSwitchScopeType,scopeKey:string,enabled:boolean,reason:string,now:string):KillSwitch;
}
