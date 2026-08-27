import { resolve } from "node:path";
import type { EffectiveConfigurationChange, EffectiveConfigurationChangeCommandPort, EffectiveConfigurationChangeKind } from "../../domain/effective-configuration-change.js";
import type { OperatingCalendar } from "../../domain/operating-calendar.js";
import type { SchedulingPolicy } from "../../domain/scheduling.js";
import type { PublishingProgramDraft } from "../../application/publishing-program-management.js";
import { EffectiveConfigurationChangeService, type EffectiveChangeDraft } from "../../application/effective-configuration-change.js";
import { workspaceRuntimeLayout } from "../../application/workspaces.js";
import { JsonDistributionConfigurationStore } from "../distribution/json-config-store.js";
import { SqliteEffectiveConfigurationChangeStore } from "../distribution/sqlite-effective-config-changes.js";
import { SqliteControlPlaneStore } from "../storage/sqlite.js";

function draft(kind:EffectiveConfigurationChangeKind,payload:unknown):EffectiveChangeDraft{
  if(kind==="PROGRAM")return{kind,payload:payload as PublishingProgramDraft};
  if(kind==="RHYTHM")return{kind,payload:payload as {id:string;policy:SchedulingPolicy}};
  return{kind,payload:payload as OperatingCalendar};
}

export class WorkspaceEffectiveConfigurationCommands implements EffectiveConfigurationChangeCommandPort {
  private readonly changes:SqliteEffectiveConfigurationChangeStore;
  private readonly control:SqliteControlPlaneStore;
  private readonly service:EffectiveConfigurationChangeService;

  constructor(options:{runtimeRoot:string;workspaceId:string}){
    const layout=workspaceRuntimeLayout(resolve(options.runtimeRoot),options.workspaceId);
    const config=new JsonDistributionConfigurationStore(resolve(layout.configDir,"distribution.json"));
    this.changes=new SqliteEffectiveConfigurationChangeStore(layout.databasePath);
    this.control=new SqliteControlPlaneStore(layout.databasePath);
    this.service=new EffectiveConfigurationChangeService(this.changes,config,()=>this.control.listSocialAccounts().map(record=>record.account));
  }

  schedule(kind:EffectiveConfigurationChangeKind,payload:unknown,effectiveBusinessDate:string,now:string,createdBy:string):EffectiveConfigurationChange{
    return this.service.schedule(draft(kind,payload),effectiveBusinessDate,now,createdBy);
  }
  listPending():readonly EffectiveConfigurationChange[]{return this.changes.list("PENDING");}
  cancel(changeId:string,now:string,reason:string):EffectiveConfigurationChange{return this.service.cancel(changeId,now,reason);}

  close():void{this.control.close();this.changes.close();}
}
