import { resolve } from "node:path";
import type { IncidentOperatorCommandPort } from "../../domain/incident-operator-ports.js";
import type { KillSwitchScopeType } from "../../domain/operations.js";
import { HumanRecoveryService, KillSwitchService } from "../../application/operations.js";
import { workspaceRuntimeLayout } from "../../application/workspaces.js";
import { SqliteControlPlaneStore } from "../storage/sqlite.js";

export class WorkspaceIncidentOperatorCommands implements IncidentOperatorCommandPort {
  private readonly store:SqliteControlPlaneStore;
  private readonly recovery:HumanRecoveryService;
  private readonly killSwitches:KillSwitchService;
  constructor(runtimeRoot:string,workspaceId:string,private readonly operatorId="control-center"){
    const layout=workspaceRuntimeLayout(resolve(runtimeRoot),workspaceId);
    this.store=new SqliteControlPlaneStore(layout.databasePath);
    this.recovery=new HumanRecoveryService(this.store);
    this.killSwitches=new KillSwitchService(this.store);
  }
  acknowledge(incidentId:string,now:string,note?:string):void{this.recovery.acknowledgeIncident(incidentId,now,this.operatorId,note);}
  resolve(incidentId:string,now:string,note:string):void{this.recovery.resolveIncident(incidentId,now,this.operatorId,note);}
  resumeIntent(incidentId:string,now:string,note:string):void{
    const incident=this.store.getIncident(incidentId);if(!incident)throw new Error(`Unknown incident: ${incidentId}`);
    if(!incident.scope.intentId)throw new Error(`Incident ${incidentId} has no publication intent`);
    if(incident.kind==="PUBLISH_UNCERTAIN")throw new Error("PUBLISH_UNCERTAIN cannot be resumed; reconciliation is mandatory");
    this.recovery.resumeIntent(incident.scope.intentId,now,this.operatorId,note);
    this.recovery.resolveIncident(incidentId,now,this.operatorId,`Intent resumed safely: ${note}`);
  }
  waiveIntent(incidentId:string,now:string,reason:string):void{
    const incident=this.store.getIncident(incidentId);if(!incident)throw new Error(`Unknown incident: ${incidentId}`);
    if(!incident.scope.intentId)throw new Error(`Incident ${incidentId} has no publication intent`);
    if(incident.kind!=="MISSED_WINDOW")throw new Error("Waive from Incident UI is limited to MISSED_WINDOW incidents");
    this.recovery.waiveIntent(incident.scope.intentId,now,this.operatorId,reason);
    this.recovery.resolveIncident(incidentId,now,this.operatorId,`Slot waived: ${reason}`);
  }
  listKillSwitches(){return this.store.listKillSwitches();}
  setKillSwitch(scopeType:KillSwitchScopeType,scopeKey:string,enabled:boolean,reason:string,now:string){return this.killSwitches.set(scopeType,scopeKey,enabled,reason,now,this.operatorId);}
  close():void{this.store.close();}
}
