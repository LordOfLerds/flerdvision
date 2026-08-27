import type { DistributionConfigurationStorePort } from "../../domain/distribution-ports.js";
import type { ControlCenterRuntimePort, ControlCenterRuntimeSnapshot } from "../../domain/control-center-ports.js";
import type { ChannelReadiness, SurfaceReadiness } from "../../application/control-center-read-model.js";
import type { DailyPlan } from "../../domain/distribution.js";
import { sourceActivationStatus } from "../../application/source-activation-command.js";
import { DistributionDeliveryAggregateProjector } from "../../application/distribution-delivery-aggregate.js";
import { SqliteControlPlaneStore } from "../storage/sqlite.js";
import { SqliteDistributionRuntimeStateStore } from "../distribution/sqlite-runtime-state.js";
import { SqlitePlatformSurfaceStore } from "../distribution/sqlite-surface-store.js";
import { SqliteSourceActivationBaselineStore } from "../distribution/sqlite-source-activation.js";
import { SqliteDistributionProvenanceStore } from "../distribution/sqlite-provenance.js";
import { SqliteRuntimeCycleReportStore } from "../runtime/sqlite-cycle-runtime.js";

function missingPlan(businessDate:string):DailyPlan{
  return{planId:`daily-plan:missing:${businessDate}`,businessDate,generatedAt:new Date(0).toISOString(),deliveries:[],gaps:[],backlog:[]};
}

/** Joins revisioned management config with durable runtime/evidence state; it never invents readiness. */
export class SqliteControlCenterRuntimeAdapter implements ControlCenterRuntimePort {
  private readonly control:SqliteControlPlaneStore;
  private readonly distribution:SqliteDistributionRuntimeStateStore;
  private readonly surfaces:SqlitePlatformSurfaceStore;
  private readonly baselines:SqliteSourceActivationBaselineStore;
  private readonly provenance:SqliteDistributionProvenanceStore;
  private readonly cycles:SqliteRuntimeCycleReportStore;

  constructor(databasePath:string,private readonly config:DistributionConfigurationStorePort,workspaceId:string){
    this.control=new SqliteControlPlaneStore(databasePath);
    this.distribution=new SqliteDistributionRuntimeStateStore(databasePath);
    this.surfaces=new SqlitePlatformSurfaceStore(databasePath);
    this.baselines=new SqliteSourceActivationBaselineStore(databasePath);
    this.provenance=new SqliteDistributionProvenanceStore(databasePath);
    this.cycles=new SqliteRuntimeCycleReportStore(databasePath,workspaceId);
  }

  async snapshot(businessDate:string):Promise<ControlCenterRuntimeSnapshot>{
    const stored=this.config.load();
    const accounts=this.control.listSocialAccounts().map((record)=>record.account);
    const identities=this.control.listBrowserIdentities();
    const accountHealth:ChannelReadiness[]=accounts.map((account)=>{
      const identity=identities.find((record)=>record.identity.accountId===account.accountId)?.identity;
      const health=identity?this.control.latestSessionHealth(identity.identityId):null;
      return{accountId:account.accountId,sessionHealth:health?.state??"UNKNOWN",identityVerified:Boolean(health?.state==="HEALTHY")};
    });

    const pairs=new Map<string,{accountId:string;postingProfileId:string}>();
    for(const route of stored.config.routes)pairs.set(`${route.accountId}|${route.postingProfileId}`,{accountId:route.accountId,postingProfileId:route.postingProfileId});
    const surfaceReadiness:SurfaceReadiness[]=[];
    for(const pair of pairs.values()){
      const version=this.surfaces.latestContract(pair.accountId,pair.postingProfileId);
      if(!version){surfaceReadiness.push({...pair,surfaceContract:"UNVERIFIED"});continue;}
      const replays=this.surfaces.listReplays(version.contract.contractId),latest=replays[replays.length-1];
      const state:SurfaceReadiness["surfaceContract"]=latest&&!latest.passed?"DRIFTED":version.contract.status==="CALIBRATED"?"CALIBRATED":"UNVERIFIED";
      surfaceReadiness.push({...pair,surfaceContract:state,contractId:version.contract.contractId,environmentFingerprint:version.contract.environment.fingerprint});
    }

    const channelReadiness:ChannelReadiness[]=accountHealth.map((channel)=>{
      const states=surfaceReadiness.filter((item)=>item.accountId===channel.accountId).map((item)=>item.surfaceContract);
      const surfaceContract:NonNullable<ChannelReadiness["surfaceContract"]>=states.includes("DRIFTED")?"DRIFTED":states.length>0&&states.every((state)=>state==="CALIBRATED")?"CALIBRATED":"UNVERIFIED";
      return{...channel,surfaceContract};
    });

    const plan=this.distribution.latestDailyPlan(businessDate)?.plan??missingPlan(businessDate);
    const aggregates=new DistributionDeliveryAggregateProjector(this.distribution,this.provenance,this.control,this.control).project().map((item)=>item.aggregate);
    const sourceActivation=stored.config.lanes.map((lane)=>sourceActivationStatus(stored,this.baselines,lane.laneId));
    return{
      plan,
      accounts,
      channelReadiness,
      surfaceReadiness,
      routeTests:this.distribution.listRouteTestReadiness().map((record)=>record.readiness),
      assets:this.distribution.listAssets().map((record)=>record.asset),
      deliveryAggregates:aggregates,
      sourceActivation,
      incidents:this.control.listIncidents(),
      auditEvents:this.control.listEvents(),
      runtimeCycles:this.cycles.latest(50)
    };
  }

  close():void{
    this.cycles.close();
    this.provenance.close();
    this.baselines.close();
    this.surfaces.close();
    this.distribution.close();
    this.control.close();
  }
}
