import type { DistributionConfigurationStorePort } from "../../domain/distribution-ports.js";
import type { ControlCenterRuntimePort, ControlCenterRuntimeSnapshot } from "../../domain/control-center-ports.js";
import type { ChannelReadiness, SurfaceReadiness } from "../../application/control-center-read-model.js";
import type { DailyPlan } from "../../domain/distribution.js";
import { SqliteControlPlaneStore } from "../storage/sqlite.js";
import { SqliteDistributionRuntimeStateStore } from "../distribution/sqlite-runtime-state.js";
import { SqlitePlatformSurfaceStore } from "../distribution/sqlite-surface-store.js";

function missingPlan(businessDate:string):DailyPlan{
  return{
    planId:`daily-plan:missing:${businessDate}`,
    businessDate,
    generatedAt:new Date(0).toISOString(),
    deliveries:[],gaps:[],backlog:[]
  };
}

/**
 * Real Control Center read adapter over the workspace database.
 *
 * Management configuration stays in its revisioned store; accounts/session health, plans/assets,
 * route tests and surface contracts are runtime evidence. The adapter joins them without inventing
 * readiness: absent plan/surface/test evidence remains visibly empty or UNVERIFIED.
 */
export class SqliteControlCenterRuntimeAdapter implements ControlCenterRuntimePort {
  private readonly control:SqliteControlPlaneStore;
  private readonly distribution:SqliteDistributionRuntimeStateStore;
  private readonly surfaces:SqlitePlatformSurfaceStore;

  constructor(databasePath:string,private readonly config:DistributionConfigurationStorePort){
    this.control=new SqliteControlPlaneStore(databasePath);
    this.distribution=new SqliteDistributionRuntimeStateStore(databasePath);
    this.surfaces=new SqlitePlatformSurfaceStore(databasePath);
  }

  async snapshot(businessDate:string):Promise<ControlCenterRuntimeSnapshot>{
    const stored=this.config.load();
    const accounts=this.control.listSocialAccounts().map((record)=>record.account);
    const identities=this.control.listBrowserIdentities();
    const channelReadiness:ChannelReadiness[]=accounts.map((account)=>{
      const identity=identities.find((record)=>record.identity.accountId===account.accountId)?.identity;
      const health=identity?this.control.latestSessionHealth(identity.identityId):null;
      return{
        accountId:account.accountId,
        sessionHealth:health?.state??"UNKNOWN",
        identityVerified:Boolean(health?.state==="HEALTHY")
      };
    });

    const pairs=new Map<string,{accountId:string;postingProfileId:string}>();
    for(const route of stored.config.routes){
      pairs.set(`${route.accountId}|${route.postingProfileId}`,{accountId:route.accountId,postingProfileId:route.postingProfileId});
    }
    const surfaceReadiness:SurfaceReadiness[]=[];
    for(const pair of pairs.values()){
      const version=this.surfaces.latestContract(pair.accountId,pair.postingProfileId);
      if(!version){
        surfaceReadiness.push({...pair,surfaceContract:"UNVERIFIED"});
        continue;
      }
      const replays=this.surfaces.listReplays(version.contract.contractId);
      const latest=replays[replays.length-1];
      const state:SurfaceReadiness["surfaceContract"]=latest&&!latest.passed
        ? "DRIFTED"
        : version.contract.status==="CALIBRATED"
          ? "CALIBRATED"
          : "UNVERIFIED";
      surfaceReadiness.push({
        ...pair,
        surfaceContract:state,
        contractId:version.contract.contractId,
        environmentFingerprint:version.contract.environment.fingerprint
      });
    }

    return{
      plan:this.distribution.latestDailyPlan(businessDate)?.plan??missingPlan(businessDate),
      accounts,
      channelReadiness,
      surfaceReadiness,
      routeTests:this.distribution.listRouteTestReadiness().map((record)=>record.readiness),
      assets:this.distribution.listAssets().map((record)=>record.asset)
    };
  }

  close():void{
    this.surfaces.close();
    this.distribution.close();
    this.control.close();
  }
}
