import { resolve } from "node:path";
import type { WorkspaceRuntimeLayout } from "../../domain/workspace.js";
import { workspaceRuntimeLayout } from "../../application/workspaces.js";
import { SourceActivationCommandService } from "../../application/source-activation-command.js";
import { DistributionSourceScanCoordinator } from "../../application/distribution-source-scan.js";
import { DistributionDeliveryAggregateProjector } from "../../application/distribution-delivery-aggregate.js";
import { RuntimeDistributionDispositionAdapter } from "../../application/runtime-distribution-disposition.js";
import { RuntimeSupervisor } from "../../application/runtime-supervisor.js";
import { MaterializingMediaReadinessProbe } from "../distribution/materializing-readiness-probe.js";
import { FfprobeMediaInspector } from "../media/ffprobe-inspector.js";
import { JsonDistributionConfigurationStore } from "../distribution/json-config-store.js";
import { SqliteDistributionRuntimeStateStore } from "../distribution/sqlite-runtime-state.js";
import { SqliteSourceActivationBaselineStore } from "../distribution/sqlite-source-activation.js";
import { SqliteDistributionProvenanceStore } from "../distribution/sqlite-provenance.js";
import { PersistedPlanningCommitmentAdapter } from "../distribution/sqlite-planning-commitments.js";
import { SqliteControlPlaneStore } from "../storage/sqlite.js";
import { NoopSourceDispositionAdapter } from "../disposition/adapters.js";
import { ConfiguredDistributionDispositionExecutor } from "../disposition/distribution-executor.js";
import { SourceLaneObservationAdapter } from "../ingress/source-lane-observer.js";
import { ConfiguredSourceLaneInterpreterFactory } from "../ingress/source-lane-interpreters.js";
import { GoogleDriveRestReadClient } from "../ingress/google-drive.js";
import { workspaceDriveAccessTokenProvider } from "../ingress/google-drive/workspace-drive-token.js";
import { WorkspaceMediaMaterializer } from "../publish/workspace-media-materializer.js";
import { PersistedDistributionPlannerAdapter, RuntimeDistributionSourceScanAdapter } from "../../application/runtime-source-planner-adapters.js";
import { DistributionPlanProvenanceService, DistributionIntentMaterializer } from "../../application/distribution-intent-materializer.js";
import { ProvenancedRuntimePlannerAdapter, RuntimeDistributionIntentMaterializerAdapter } from "../../application/runtime-distribution-adapters.js";
import { ControlPlaneRuntimeCycleLeaseAdapter, SqliteRuntimeCycleReportStore } from "./sqlite-cycle-runtime.js";
import { FrozenRuntimeDueExecutionAdapter, RecoveryOnlyRuntimeReconciliationAdapter, W6RuntimeOperationsAdapter } from "./safe-phase-adapters.js";

export interface WorkspaceDistributionRuntimeOptions {
  runtimeRoot:string;
  workspaceId:string;
  env?:Record<string,string|undefined>;
  notificationChannelKeys?:readonly string[];
  timeZone?:string;
}

/**
 * One composition root for Luca Mac, Fabian Mac and VPS. While R0 is active, its due adapter is
 * physically frozen: the same supervisor runs source/planning/recovery/disposition/operations but
 * cannot claim a publication intent.
 */
export class WorkspaceDistributionRuntime {
  readonly layout:WorkspaceRuntimeLayout;
  readonly config:JsonDistributionConfigurationStore;
  readonly control:SqliteControlPlaneStore;
  readonly state:SqliteDistributionRuntimeStateStore;
  readonly baselines:SqliteSourceActivationBaselineStore;
  readonly provenance:SqliteDistributionProvenanceStore;
  readonly reports:SqliteRuntimeCycleReportStore;
  readonly observations:SourceLaneObservationAdapter;
  readonly activation:SourceActivationCommandService;
  readonly source:RuntimeDistributionSourceScanAdapter;
  readonly planner:ProvenancedRuntimePlannerAdapter;
  readonly intents:RuntimeDistributionIntentMaterializerAdapter;
  readonly lease:ControlPlaneRuntimeCycleLeaseAdapter;
  readonly due:FrozenRuntimeDueExecutionAdapter;
  readonly reconciliation:RecoveryOnlyRuntimeReconciliationAdapter;
  readonly disposition:RuntimeDistributionDispositionAdapter;
  readonly operations:W6RuntimeOperationsAdapter;

  constructor(private readonly options:WorkspaceDistributionRuntimeOptions){
    const env=options.env??process.env;
    this.layout=workspaceRuntimeLayout(resolve(options.runtimeRoot),options.workspaceId);
    this.config=new JsonDistributionConfigurationStore(resolve(this.layout.configDir,"distribution.json"));
    this.control=new SqliteControlPlaneStore(this.layout.databasePath);
    this.state=new SqliteDistributionRuntimeStateStore(this.layout.databasePath);
    this.baselines=new SqliteSourceActivationBaselineStore(this.layout.databasePath);
    this.provenance=new SqliteDistributionProvenanceStore(this.layout.databasePath);
    this.reports=new SqliteRuntimeCycleReportStore(this.layout.databasePath,options.workspaceId);

    const driveToken=workspaceDriveAccessTokenProvider({configDir:this.layout.configDir,env});
    const driveClient=driveToken?new GoogleDriveRestReadClient(driveToken):undefined;
    this.observations=new SourceLaneObservationAdapter(driveClient?{googleDriveClient:driveClient}:{});
    this.activation=new SourceActivationCommandService(this.config,this.observations,this.baselines);

    const media=new WorkspaceMediaMaterializer(this.config,driveToken,this.layout.mediaCacheDir);
    const inspector=new FfprobeMediaInspector(env.FFPROBE_EXECUTABLE_PATH??"ffprobe");
    const scan=new DistributionSourceScanCoordinator(
      this.config,
      this.observations,
      new ConfiguredSourceLaneInterpreterFactory(),
      this.control,
      new NoopSourceDispositionAdapter(),
      this.baselines,
      this.state,
      new MaterializingMediaReadinessProbe(media,inspector),
      {notifyBlocksExternally:false}
    );
    this.source=new RuntimeDistributionSourceScanAdapter(scan);
    const commitmentAdapter=new PersistedPlanningCommitmentAdapter(this.state,this.provenance,this.control);
    const persistedPlanner=new PersistedDistributionPlannerAdapter(this.config,this.state,commitmentAdapter);
    const provenanceService=new DistributionPlanProvenanceService(this.config,this.provenance);
    this.planner=new ProvenancedRuntimePlannerAdapter(persistedPlanner,provenanceService);
    const materializer=new DistributionIntentMaterializer(this.control,this.config,this.provenance);
    this.intents=new RuntimeDistributionIntentMaterializerAdapter(materializer);

    this.lease=new ControlPlaneRuntimeCycleLeaseAdapter(this.control,options.workspaceId);
    this.due=new FrozenRuntimeDueExecutionAdapter(this.control);
    this.reconciliation=new RecoveryOnlyRuntimeReconciliationAdapter(this.control);
    const aggregates=new DistributionDeliveryAggregateProjector(this.state,this.provenance,this.control,this.control);
    const dispositionExecutor=new ConfiguredDistributionDispositionExecutor(this.control,{});
    this.disposition=new RuntimeDistributionDispositionAdapter(this.config,this.state,aggregates,dispositionExecutor);
    this.operations=new W6RuntimeOperationsAdapter(this.control,options.notificationChannelKeys??[],options.timeZone??"Europe/Vienna");
  }

  supervisor(ownerId:string,clock:()=>string=()=>new Date().toISOString()):RuntimeSupervisor{
    return new RuntimeSupervisor({
      lease:this.lease,
      source:this.source,
      planner:this.planner,
      intents:this.intents,
      due:this.due,
      reconciliation:this.reconciliation,
      disposition:this.disposition,
      operations:this.operations,
      reports:this.reports
    },ownerId,clock);
  }

  close():void{
    this.reports.close();
    this.provenance.close();
    this.baselines.close();
    this.state.close();
    this.control.close();
  }
}
