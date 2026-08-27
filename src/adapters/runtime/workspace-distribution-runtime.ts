import { resolve } from "node:path";
import { workspaceRuntimeLayout } from "../../application/workspaces.js";
import { SourceActivationCommandService } from "../../application/source-activation-command.js";
import { DistributionSourceScanCoordinator } from "../../application/distribution-source-scan.js";
import { MaterializingMediaReadinessProbe } from "../distribution/materializing-readiness-probe.js";
import { JsonDistributionConfigurationStore } from "../distribution/json-config-store.js";
import { SqliteDistributionRuntimeStateStore } from "../distribution/sqlite-runtime-state.js";
import { SqliteSourceActivationBaselineStore } from "../distribution/sqlite-source-activation.js";
import { SqliteDistributionProvenanceStore } from "../distribution/sqlite-provenance.js";
import { SqliteControlPlaneStore } from "../storage/sqlite.js";
import { NoopSourceDispositionAdapter } from "../disposition/adapters.js";
import { SourceLaneObservationAdapter } from "../ingress/source-lane-observer.js";
import { ConfiguredSourceLaneInterpreterFactory } from "../ingress/source-lane-interpreters.js";
import { GoogleDriveRestReadClient } from "../ingress/google-drive.js";
import { workspaceDriveAccessTokenProvider } from "../ingress/google-drive/workspace-drive-token.js";
import { WorkspaceMediaMaterializer } from "../publish/workspace-media-materializer.js";
import { PersistedDistributionPlannerAdapter, RuntimeDistributionSourceScanAdapter } from "../../application/runtime-source-planner-adapters.js";
import { DistributionPlanProvenanceService, DistributionIntentMaterializer } from "../../application/distribution-intent-materializer.js";
import { ProvenancedRuntimePlannerAdapter, RuntimeDistributionIntentMaterializerAdapter } from "../../application/runtime-distribution-adapters.js";

export interface WorkspaceDistributionRuntimeOptions {
  runtimeRoot:string;
  workspaceId:string;
  env?:Record<string,string|undefined>;
}

/**
 * One composition root for source/planning runtime on Luca Mac, Fabian Mac and VPS. No component
 * may select another workspace's credential/config/database implicitly.
 */
export class WorkspaceDistributionRuntime {
  readonly layout;
  readonly config:JsonDistributionConfigurationStore;
  readonly control:SqliteControlPlaneStore;
  readonly state:SqliteDistributionRuntimeStateStore;
  readonly baselines:SqliteSourceActivationBaselineStore;
  readonly provenance:SqliteDistributionProvenanceStore;
  readonly observations:SourceLaneObservationAdapter;
  readonly activation:SourceActivationCommandService;
  readonly source:RuntimeDistributionSourceScanAdapter;
  readonly planner:ProvenancedRuntimePlannerAdapter;
  readonly intents:RuntimeDistributionIntentMaterializerAdapter;

  constructor(options:WorkspaceDistributionRuntimeOptions){
    this.layout=workspaceRuntimeLayout(resolve(options.runtimeRoot),options.workspaceId);
    this.config=new JsonDistributionConfigurationStore(resolve(this.layout.configDir,"distribution.json"));
    this.control=new SqliteControlPlaneStore(this.layout.databasePath);
    this.state=new SqliteDistributionRuntimeStateStore(this.layout.databasePath);
    this.baselines=new SqliteSourceActivationBaselineStore(this.layout.databasePath);
    this.provenance=new SqliteDistributionProvenanceStore(this.layout.databasePath);

    const driveToken=workspaceDriveAccessTokenProvider({configDir:this.layout.configDir,env:options.env??process.env});
    const driveClient=driveToken?new GoogleDriveRestReadClient(driveToken):undefined;
    this.observations=new SourceLaneObservationAdapter(driveClient?{googleDriveClient:driveClient}:{});
    this.activation=new SourceActivationCommandService(this.config,this.observations,this.baselines);

    const media=new WorkspaceMediaMaterializer(this.config,driveToken,this.layout.mediaCacheDir);
    const scan=new DistributionSourceScanCoordinator(
      this.config,
      this.observations,
      new ConfiguredSourceLaneInterpreterFactory(),
      this.control,
      new NoopSourceDispositionAdapter(),
      this.baselines,
      this.state,
      new MaterializingMediaReadinessProbe(media),
      {notifyBlocksExternally:false}
    );
    this.source=new RuntimeDistributionSourceScanAdapter(scan);
    const persistedPlanner=new PersistedDistributionPlannerAdapter(this.config,this.state);
    const provenanceService=new DistributionPlanProvenanceService(this.config,this.provenance);
    this.planner=new ProvenancedRuntimePlannerAdapter(persistedPlanner,provenanceService);
    const materializer=new DistributionIntentMaterializer(this.control,this.config,this.provenance);
    this.intents=new RuntimeDistributionIntentMaterializerAdapter(materializer);
  }

  close():void{
    this.provenance.close();
    this.baselines.close();
    this.state.close();
    this.control.close();
  }
}
