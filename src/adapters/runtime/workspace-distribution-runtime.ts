import { join, resolve } from "node:path";
import type { WorkspaceRuntimeLayout } from "../../domain/workspace.js";
import { workspaceRuntimeLayout } from "../../application/workspaces.js";
import { SourceActivationCommandService } from "../../application/source-activation-command.js";
import { DistributionSourceScanCoordinator } from "../../application/distribution-source-scan.js";
import { DistributionDeliveryAggregateProjector } from "../../application/distribution-delivery-aggregate.js";
import { RuntimeDistributionDispositionAdapter } from "../../application/runtime-distribution-disposition.js";
import { RuntimeSupervisor } from "../../application/runtime-supervisor.js";
import { PollingRuntimeSourceScanAdapter } from "../../application/runtime-polling-source.js";
import { PersistedRouteExecutionQualificationGate } from "../../application/route-execution-qualification.js";
import { VerifiedMediaCacheMaintenance } from "../../application/verified-media-cache-maintenance.js";
import { EffectiveConfigurationChangeService } from "../../application/effective-configuration-change.js";
import { EffectiveConfigurationPlannerDecorator } from "../../application/effective-config-planner-decorator.js";
import { NotificationDispatcher } from "../../application/notifications.js";
import { DEFAULT_DISTRIBUTION_RUNTIME_POLICY } from "../../domain/distribution-operations.js";
import { MaterializingMediaReadinessProbe } from "../distribution/materializing-readiness-probe.js";
import { FfprobeMediaInspector } from "../media/ffprobe-inspector.js";
import { JsonDistributionConfigurationStore } from "../distribution/json-config-store.js";
import { SqliteDistributionRuntimeStateStore } from "../distribution/sqlite-runtime-state.js";
import { SqliteSourceActivationBaselineStore } from "../distribution/sqlite-source-activation.js";
import { SqliteDistributionProvenanceStore } from "../distribution/sqlite-provenance.js";
import { SqliteEffectiveConfigurationChangeStore } from "../distribution/sqlite-effective-config-changes.js";
import { PersistedPlanningCommitmentAdapter } from "../distribution/sqlite-planning-commitments.js";
import { SqlitePlatformSurfaceStore } from "../distribution/sqlite-surface-store.js";
import { SqliteSourcePollingStateStore } from "../distribution/sqlite-source-poll-state.js";
import { SqliteControlPlaneStore } from "../storage/sqlite.js";
import { NoopSourceDispositionAdapter } from "../disposition/adapters.js";
import { ConfiguredDistributionDispositionExecutor } from "../disposition/distribution-executor.js";
import { buildWorkspaceDispositionAdapterRegistry } from "../disposition/workspace-registry.js";
import { SourceLaneObservationAdapter } from "../ingress/source-lane-observer.js";
import { ConfiguredSourceLaneInterpreterFactory } from "../ingress/source-lane-interpreters.js";
import { GoogleDriveRestReadClient } from "../ingress/google-drive.js";
import { workspaceDriveAccessTokenProvider } from "../ingress/google-drive/workspace-drive-token.js";
import { WebhookNotificationAdapter } from "../notify/webhook.js";
import { telegramAdapterFromEnv } from "../notify/telegram.js";
import { WorkspaceMediaMaterializer } from "../publish/workspace-media-materializer.js";
import { VerifiedMediaCacheMaterializer } from "../publish/verified-media-cache.js";
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
  /** noVNC/remote-screen URL offered when an attention item is a login problem. */
  remoteScreenUrl?:string;
  releaseSha?:string;
}

/** One composition root for Mac and VPS hosts. R0 keeps due execution physically frozen. */
export class WorkspaceDistributionRuntime {
  readonly layout:WorkspaceRuntimeLayout;
  readonly config:JsonDistributionConfigurationStore;
  readonly control:SqliteControlPlaneStore;
  readonly state:SqliteDistributionRuntimeStateStore;
  readonly baselines:SqliteSourceActivationBaselineStore;
  readonly provenance:SqliteDistributionProvenanceStore;
  readonly surfaces:SqlitePlatformSurfaceStore;
  readonly effectiveChanges:SqliteEffectiveConfigurationChangeStore;
  readonly pollState:SqliteSourcePollingStateStore;
  readonly reports:SqliteRuntimeCycleReportStore;
  readonly observations:SourceLaneObservationAdapter;
  readonly activation:SourceActivationCommandService;
  readonly media:VerifiedMediaCacheMaterializer;
  readonly mediaMaintenance:VerifiedMediaCacheMaintenance;
  readonly source:PollingRuntimeSourceScanAdapter;
  readonly planner:EffectiveConfigurationPlannerDecorator;
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
    this.surfaces=new SqlitePlatformSurfaceStore(this.layout.databasePath);
    this.effectiveChanges=new SqliteEffectiveConfigurationChangeStore(this.layout.databasePath);
    this.pollState=new SqliteSourcePollingStateStore(this.layout.databasePath);
    this.reports=new SqliteRuntimeCycleReportStore(this.layout.databasePath,options.workspaceId);

    const driveToken=workspaceDriveAccessTokenProvider({configDir:this.layout.configDir,env}),driveClient=driveToken?new GoogleDriveRestReadClient(driveToken):undefined;
    this.observations=new SourceLaneObservationAdapter(driveClient?{googleDriveClient:driveClient}:{});
    this.activation=new SourceActivationCommandService(this.config,this.observations,this.baselines);

    const providerMedia=new WorkspaceMediaMaterializer(this.config,driveToken,join(this.layout.mediaCacheDir,"provider-temp"));
    this.media=new VerifiedMediaCacheMaterializer(providerMedia,join(this.layout.mediaCacheDir,"verified"));
    this.mediaMaintenance=new VerifiedMediaCacheMaintenance(this.media);
    const inspector=new FfprobeMediaInspector(env.FFPROBE_EXECUTABLE_PATH??"ffprobe");
    const scan=new DistributionSourceScanCoordinator(this.config,this.observations,new ConfiguredSourceLaneInterpreterFactory(),this.control,new NoopSourceDispositionAdapter(),this.baselines,this.state,new MaterializingMediaReadinessProbe(this.media,inspector),{notifyBlocksExternally:false});
    this.source=new PollingRuntimeSourceScanAdapter(new RuntimeDistributionSourceScanAdapter(scan),this.config,this.pollState);
    const commitmentAdapter=new PersistedPlanningCommitmentAdapter(this.state,this.provenance,this.control),persistedPlanner=new PersistedDistributionPlannerAdapter(this.config,this.state,commitmentAdapter),provenanceService=new DistributionPlanProvenanceService(this.config,this.provenance),provenancedPlanner=new ProvenancedRuntimePlannerAdapter(persistedPlanner,provenanceService),effectiveService=new EffectiveConfigurationChangeService(this.effectiveChanges,this.config,()=>this.control.listSocialAccounts().map(record=>record.account));
    this.planner=new EffectiveConfigurationPlannerDecorator(effectiveService,provenancedPlanner);

    const releaseSha=options.releaseSha??env.FLERDVISION_RELEASE_SHA??"UNSET_RELEASE_SHA",qualification=new PersistedRouteExecutionQualificationGate(this.config,this.state,this.surfaces,releaseSha),materializer=new DistributionIntentMaterializer(this.control,this.config,this.provenance,qualification);
    this.intents=new RuntimeDistributionIntentMaterializerAdapter(materializer);

    this.lease=new ControlPlaneRuntimeCycleLeaseAdapter(this.control,options.workspaceId);
    this.due=new FrozenRuntimeDueExecutionAdapter(this.control);
    this.reconciliation=new RecoveryOnlyRuntimeReconciliationAdapter(this.control);
    const aggregates=new DistributionDeliveryAggregateProjector(this.state,this.provenance,this.control,this.control),dispositionAdapters=buildWorkspaceDispositionAdapterRegistry(this.config.load(),this.control,driveToken),dispositionExecutor=new ConfiguredDistributionDispositionExecutor(this.control,dispositionAdapters);
    this.disposition=new RuntimeDistributionDispositionAdapter(this.config,this.state,aggregates,dispositionExecutor);

    const webhookUrl=env.FLERDVISION_NOTIFICATION_WEBHOOK_URL,webhookChannelKey=env.FLERDVISION_NOTIFICATION_WEBHOOK_CHANNEL_KEY??"current-bot";
    const webhook=webhookUrl?new WebhookNotificationAdapter({channelKey:webhookChannelKey,url:webhookUrl,...(env.FLERDVISION_NOTIFICATION_WEBHOOK_TOKEN?{bearerToken:env.FLERDVISION_NOTIFICATION_WEBHOOK_TOKEN}:{})}):undefined;
    const telegram=telegramAdapterFromEnv(env);
    const notificationAdapters=[...(webhook?[webhook]:[]),...(telegram?[telegram]:[])];
    const notificationChannelKeys=options.notificationChannelKeys??notificationAdapters.map((adapter)=>adapter.channelKey),notificationDispatcher=notificationAdapters.length>0?new NotificationDispatcher(this.control,notificationAdapters):undefined;
    this.operations=new W6RuntimeOperationsAdapter(this.control,notificationChannelKeys,options.timeZone??"Europe/Vienna",{distributionConfig:this.config,distributionRuntime:this.state,...((options.remoteScreenUrl??env.FLERDVISION_REMOTE_SCREEN_URL)?{remoteScreenUrl:(options.remoteScreenUrl??env.FLERDVISION_REMOTE_SCREEN_URL)!}:{}),...(notificationDispatcher?{notificationDispatcher}:{})});
  }

  supervisor(ownerId:string,clock:()=>string=()=>new Date().toISOString()):RuntimeSupervisor{return new RuntimeSupervisor({lease:this.lease,source:this.source,planner:this.planner,intents:this.intents,due:this.due,reconciliation:this.reconciliation,disposition:this.disposition,operations:this.operations,reports:this.reports},ownerId,clock);}
  async maintainMediaCache(now:string){const retention=this.config.load().runtimePolicy?.mediaCache.retentionHoursAfterComplete??DEFAULT_DISTRIBUTION_RUNTIME_POLICY.mediaCache.retentionHoursAfterComplete;return await this.mediaMaintenance.evictEligible(this.state.listAssets().map(record=>record.asset),now,retention);}
  close():void{this.reports.close();this.pollState.close();this.effectiveChanges.close();this.surfaces.close();this.provenance.close();this.baselines.close();this.state.close();this.control.close();}
}
