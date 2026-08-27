import { resolve } from "node:path";
import type { RouteTestCommandCapability, RouteTestCommandPort, RouteTestCommandResult } from "../../domain/route-test-command-ports.js";
import type { ExecutableRouteTestKey } from "../../domain/route-test-ports.js";
import { workspaceRuntimeLayout } from "../../application/workspaces.js";
import { PersistingRouteTestCommandService } from "../../application/route-test-command.js";
import { JsonDistributionConfigurationStore } from "../distribution/json-config-store.js";
import { SqliteDistributionRuntimeStateStore } from "../distribution/sqlite-runtime-state.js";
import { SqliteSourceActivationBaselineStore } from "../distribution/sqlite-source-activation.js";
import { SqlitePlatformSurfaceStore } from "../distribution/sqlite-surface-store.js";
import { SqliteRouteTestEvidenceStore } from "../distribution/sqlite-route-test-evidence.js";
import { SqliteControlPlaneStore } from "../storage/sqlite.js";
import { SourceLaneObservationAdapter } from "../ingress/source-lane-observer.js";
import { GoogleDriveRestReadClient } from "../ingress/google-drive.js";
import { workspaceDriveAccessTokenProvider } from "../ingress/google-drive/workspace-drive-token.js";
import { SafeObserverRouteTestRunner } from "./safe-route-test-runner.js";

export interface WorkspaceRouteTestCommandsOptions {
  runtimeRoot:string;
  workspaceId:string;
  releaseSha:string;
  env?:Record<string,string|undefined>;
}

export class WorkspaceRouteTestCommands implements RouteTestCommandPort {
  private readonly control:SqliteControlPlaneStore;
  private readonly runtime:SqliteDistributionRuntimeStateStore;
  private readonly baselines:SqliteSourceActivationBaselineStore;
  private readonly surfaces:SqlitePlatformSurfaceStore;
  private readonly evidence:SqliteRouteTestEvidenceStore;
  private readonly service:PersistingRouteTestCommandService;

  constructor(options:WorkspaceRouteTestCommandsOptions){
    if(!options.releaseSha.trim())throw new Error("Workspace route tests require releaseSha");
    const layout=workspaceRuntimeLayout(resolve(options.runtimeRoot),options.workspaceId);
    const config=new JsonDistributionConfigurationStore(resolve(layout.configDir,"distribution.json"));
    this.control=new SqliteControlPlaneStore(layout.databasePath);
    this.runtime=new SqliteDistributionRuntimeStateStore(layout.databasePath);
    this.baselines=new SqliteSourceActivationBaselineStore(layout.databasePath);
    this.surfaces=new SqlitePlatformSurfaceStore(layout.databasePath);
    this.evidence=new SqliteRouteTestEvidenceStore(layout.databasePath);
    const token=workspaceDriveAccessTokenProvider({configDir:layout.configDir,env:options.env??process.env});
    const driveClient=token?new GoogleDriveRestReadClient(token):undefined;
    const observations=new SourceLaneObservationAdapter(driveClient?{googleDriveClient:driveClient}:{});
    const runner=new SafeObserverRouteTestRunner(config,this.control,this.surfaces,observations,this.baselines);
    this.service=new PersistingRouteTestCommandService(this.evidence,runner,config,this.runtime,this.surfaces,options.releaseSha);
  }

  capabilities(routeId:string):readonly RouteTestCommandCapability[]{return this.service.capabilities(routeId);}
  run(routeId:string,testKey:ExecutableRouteTestKey,now:string):Promise<RouteTestCommandResult>{return this.service.run(routeId,testKey,now);}

  close():void{
    this.evidence.close();
    this.surfaces.close();
    this.baselines.close();
    this.runtime.close();
    this.control.close();
  }
}
