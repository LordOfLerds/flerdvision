import { resolve } from "node:path";
import type { ReleaseQualificationStorePort } from "../../domain/workspace-ports.js";
import { WorkspaceQualificationSyncService, type WorkspaceQualificationSyncReport } from "../../application/workspace-qualification-sync.js";
import { workspaceRuntimeLayout } from "../../application/workspaces.js";
import { JsonDistributionConfigurationStore } from "../distribution/json-config-store.js";
import { SqliteControlCenterRuntimeAdapter } from "../control/sqlite-control-center-runtime.js";
import { SqliteControlPlaneStore } from "../storage/sqlite.js";

/** Exact-workspace adapter used by Luca/Fabian/VPS qualification sync. */
export class WorkspaceQualificationSyncAdapter {
  private readonly config:JsonDistributionConfigurationStore;
  private readonly runtime:SqliteControlCenterRuntimeAdapter;
  private readonly control:SqliteControlPlaneStore;
  private readonly service:WorkspaceQualificationSyncService;

  constructor(options:{runtimeRoot:string;workspaceId:string},qualificationStore:ReleaseQualificationStorePort){
    const layout=workspaceRuntimeLayout(resolve(options.runtimeRoot),options.workspaceId);
    this.config=new JsonDistributionConfigurationStore(resolve(layout.configDir,"distribution.json"));
    this.runtime=new SqliteControlCenterRuntimeAdapter(layout.databasePath,this.config,options.workspaceId);
    this.control=new SqliteControlPlaneStore(layout.databasePath);
    this.service=new WorkspaceQualificationSyncService(
      qualificationStore,
      this.config,
      this.runtime,
      checkedAfter=>this.freshIdentityAccounts(checkedAfter),
      options.workspaceId
    );
  }

  private freshIdentityAccounts(checkedAfter:string):readonly string[]{
    const minimum=new Date(checkedAfter).getTime();
    const groups=new Map<string,ReturnType<SqliteControlPlaneStore["listBrowserIdentities"]>[number][]>();
    for(const record of this.control.listBrowserIdentities()){
      const identity=record.identity;if(!identity.enabled)continue;
      const group=groups.get(identity.accountId)??[];group.push(record);groups.set(identity.accountId,group);
    }
    const fresh:string[]=[];
    for(const [accountId,records] of groups){
      if(records.length!==1)continue;
      const identity=records[0]!.identity,health=this.control.latestSessionHealth(identity.identityId);
      if(!health||health.state!=="HEALTHY")continue;
      if(new Date(health.checkedAt).getTime()<minimum)continue;
      if(health.expectedHandle!==health.observedHandle)continue;
      fresh.push(accountId);
    }
    return fresh.sort();
  }

  async sync(runId:string,now:string,operatorId:string):Promise<WorkspaceQualificationSyncReport>{return await this.service.sync(runId,now,operatorId);}
  close():void{this.control.close();this.runtime.close();}
}
