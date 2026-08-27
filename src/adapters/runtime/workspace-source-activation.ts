import { resolve } from "node:path";
import { workspaceRuntimeLayout } from "../../application/workspaces.js";
import { SourceActivationCommandService } from "../../application/source-activation-command.js";
import type { SourceActivationCommandPort, SourceActivationStatus } from "../../domain/source-activation-ports.js";
import { JsonDistributionConfigurationStore } from "../distribution/json-config-store.js";
import { SqliteSourceActivationBaselineStore } from "../distribution/sqlite-source-activation.js";
import { SourceLaneObservationAdapter } from "../ingress/source-lane-observer.js";
import { GoogleDriveRestReadClient } from "../ingress/google-drive.js";
import { workspaceDriveAccessTokenProvider } from "../ingress/google-drive/workspace-drive-token.js";

export class WorkspaceSourceActivationCommands implements SourceActivationCommandPort {
  private readonly baselines:SqliteSourceActivationBaselineStore;
  private readonly service:SourceActivationCommandService;

  constructor(options:{runtimeRoot:string;workspaceId:string;env?:Record<string,string|undefined>}){
    const layout=workspaceRuntimeLayout(resolve(options.runtimeRoot),options.workspaceId);
    const config=new JsonDistributionConfigurationStore(resolve(layout.configDir,"distribution.json"));
    this.baselines=new SqliteSourceActivationBaselineStore(layout.databasePath);
    const token=workspaceDriveAccessTokenProvider({configDir:layout.configDir,env:options.env??process.env});
    const driveClient=token?new GoogleDriveRestReadClient(token):undefined;
    const observations=new SourceLaneObservationAdapter(driveClient?{googleDriveClient:driveClient}:{});
    this.service=new SourceActivationCommandService(config,observations,this.baselines);
  }

  status(laneId:string):SourceActivationStatus{return this.service.status(laneId);}
  captureBaseline(laneId:string,now:string):Promise<SourceActivationStatus>{return this.service.captureBaseline(laneId,now);}
  close():void{this.baselines.close();}
}
