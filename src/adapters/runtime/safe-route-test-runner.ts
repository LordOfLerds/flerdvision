import type { DistributionConfigurationStorePort } from "../../domain/distribution-ports.js";
import type { RouteTestExecutionAdapterPort, ExecutableRouteTestKey, RouteTestExecutionResult } from "../../domain/route-test-ports.js";
import type { RouteTestCommandCapability } from "../../domain/route-test-command-ports.js";
import type { SourceActivationBaselineStorePort, SourceLaneObservationPort } from "../../domain/source-lane-runtime.js";
import type { PlatformSurfaceStorePort } from "../../domain/platform-surface-ports.js";
import type { BrowserIdentityStorePort } from "../../domain/browser-identity-ports.js";
import { assertIdentityMatches } from "../../domain/browser-identity.js";
import { sourceActivationStatus } from "../../application/source-activation-command.js";

const SAFE_KEYS:readonly ExecutableRouteTestKey[]=["SOURCE","SESSION","IDENTITY","SURFACE"];
const ALL_KEYS:readonly ExecutableRouteTestKey[]=["SOURCE","SESSION","IDENTITY","SURFACE","PREPARE_ONLY","VERIFICATION","CLEANUP"];

export class SafeObserverRouteTestRunner implements RouteTestExecutionAdapterPort {
  constructor(
    private readonly config:DistributionConfigurationStorePort,
    private readonly browser:BrowserIdentityStorePort,
    private readonly surfaces:PlatformSurfaceStorePort,
    private readonly observations:SourceLaneObservationPort,
    private readonly baselines:SourceActivationBaselineStorePort,
    private readonly clock:()=>string=()=>new Date().toISOString()
  ){}

  capabilities(routeId:string):readonly RouteTestCommandCapability[]{
    const stored=this.config.load();
    const exists=stored.config.routes.some(route=>route.routeId===routeId);
    return ALL_KEYS.map(testKey=>{
      if(!exists)return{testKey,executable:false,reason:"Route does not exist."};
      if(SAFE_KEYS.includes(testKey))return{testKey,executable:true,reason:"Read-only observer test available on this host."};
      if(testKey==="PREPARE_ONLY")return{testKey,executable:false,reason:"Prepare-only requires the calibrated browser test adapter; observer runner cannot upload media."};
      if(testKey==="VERIFICATION")return{testKey,executable:false,reason:"Verification requires a calibrated real verification collector."};
      return{testKey,executable:false,reason:"Cleanup requires canonical secret-live E2E evidence and is never an observer action."};
    });
  }

  async run(routeId:string,testKey:ExecutableRouteTestKey):Promise<RouteTestExecutionResult>{
    if(!SAFE_KEYS.includes(testKey))throw new Error(`Route test ${testKey} is unavailable in safe observer runner`);
    const stored=this.config.load();
    const route=stored.config.routes.find(item=>item.routeId===routeId);
    if(!route)return{passed:false,summary:`Route ${routeId} does not exist.`,artifactRefs:[]};
    const lane=stored.config.lanes.find(item=>item.laneId===route.laneId);
    const source=lane?stored.config.sources.find(item=>item.connectionId===lane.connectionId):undefined;

    if(testKey==="SOURCE"){
      if(!lane||!lane.enabled)return{passed:false,summary:"Source lane is missing or disabled.",artifactRefs:[]};
      if(!source||!source.enabled)return{passed:false,summary:"Source connection is missing or disabled.",artifactRefs:[]};
      const activation=sourceActivationStatus(stored,this.baselines,lane.laneId);
      if(activation.state==="MISCONFIGURED"||activation.state==="MISSING_BASELINE")return{passed:false,summary:`Source activation is not ready: ${activation.state}${activation.reason?` (${activation.reason})`:""}.`,artifactRefs:[]};
      try{
        const observed=await this.observations.observeLane(source,lane,this.clock());
        return{passed:true,summary:`Source lane is readable; ${observed.length} media object(s) observed read-only.`,artifactRefs:[]};
      }catch(error){return{passed:false,summary:`Source read failed: ${error instanceof Error?error.message:String(error)}`,artifactRefs:[]};}
    }

    const account=this.browser.getSocialAccount(route.accountId)?.account;
    const identity=this.browser.listBrowserIdentities().find(item=>item.identity.accountId===route.accountId)?.identity;
    if(!account||!identity)return{passed:false,summary:"Social account or isolated browser identity is missing.",artifactRefs:[]};
    const health=this.browser.latestSessionHealth(identity.identityId);

    if(testKey==="SESSION"){
      return health?.state==="HEALTHY"
        ?{passed:true,summary:`Browser session ${identity.identityId} is HEALTHY.`,artifactRefs:[]}
        :{passed:false,summary:`Browser session is ${health?.state??"UNKNOWN"}; reauthentication/session check required.`,artifactRefs:[]};
    }
    if(testKey==="IDENTITY"){
      if(health?.state!=="HEALTHY")return{passed:false,summary:`Identity cannot pass while session is ${health?.state??"UNKNOWN"}.`,artifactRefs:[]};
      if(!health.observedHandle)return{passed:false,summary:"Healthy session has no observed handle evidence; identity is not proven.",artifactRefs:[]};
      return assertIdentityMatches(account.expectedHandle,health.observedHandle)
        ?{passed:true,summary:`Observed @${health.observedHandle} matches expected @${account.expectedHandle}.`,artifactRefs:[]}
        :{passed:false,summary:`Observed @${health.observedHandle} does not match expected @${account.expectedHandle}.`,artifactRefs:[]};
    }

    const surface=this.surfaces.latestContract(route.accountId,route.postingProfileId);
    if(!surface)return{passed:false,summary:"No surface contract exists for this account + posting profile.",artifactRefs:[]};
    const surfaceContractId=surface.contract.contractId;
    if(surface.contract.status!=="CALIBRATED")return{passed:false,summary:`Surface contract ${surfaceContractId} is ${surface.contract.status}, not CALIBRATED.`,artifactRefs:[],surfaceContractId};
    const replays=this.surfaces.listReplays(surfaceContractId),latest=replays.at(-1);
    if(latest&&!latest.passed)return{passed:false,summary:`Latest surface replay ${latest.replayId} failed; contract is drifted until recalibrated.`,artifactRefs:[...latest.artifactRefs],surfaceContractId};
    return{passed:true,summary:`Surface contract ${surfaceContractId} is CALIBRATED for ${route.postingProfileId}.`,artifactRefs:latest?[...latest.artifactRefs]:[],surfaceContractId};
  }
}
