import { resolve } from "node:path";
import { BrowserBootstrapService, type OperatorBrowserSession } from "../../application/browser-bootstrap.js";
import { PlatformSurfaceRegistryService } from "../../application/platform-surface-registry.js";
import { workspaceRuntimeLayout } from "../../application/workspaces.js";
import { surfaceRecipeForPostingProfile } from "../../domain/platform-surface.js";
import type { SurfaceCalibrationCommandPort, SurfaceCalibrationRouteStatus } from "../../domain/surface-calibration-command-ports.js";
import { BrowserCalibrationRecorder } from "../browser/calibration-recorder.js";
import { ChromiumCdpRuntimeAdapter } from "../browser/chromium-cdp.js";
import { BrowserProfileDirectoryResolver, DurableBrowserProfileLockAdapter, FileBrowserProfileLockAdapter } from "../browser/profile-lock.js";
import { resolveChromiumExecutablePath } from "../browser/resolve-chromium.js";
import { JsonDistributionConfigurationStore } from "../distribution/json-config-store.js";
import { SqlitePlatformSurfaceStore } from "../distribution/sqlite-surface-store.js";
import { SqliteControlPlaneStore } from "../storage/sqlite.js";

function bootstrapUrl(platform:string):string{if(platform==="instagram")return"https://www.instagram.com/";if(platform==="tiktok")return"https://www.tiktok.com/";return"https://studio.youtube.com/";}

export class WorkspaceSurfaceCalibrationCommands implements SurfaceCalibrationCommandPort {
  private readonly config:JsonDistributionConfigurationStore;
  private readonly control:SqliteControlPlaneStore;
  private readonly surfaces:SqlitePlatformSurfaceStore;
  private readonly registry:PlatformSurfaceRegistryService;
  private readonly bootstrap:BrowserBootstrapService;
  private readonly recorder=new BrowserCalibrationRecorder();
  private readonly sessions=new Map<string,{session:OperatorBrowserSession;armedStep:string|null}>();

  constructor(options:{runtimeRoot:string;workspaceId:string;chromiumExecutablePath?:string}){
    const layout=workspaceRuntimeLayout(resolve(options.runtimeRoot),options.workspaceId);
    this.config=new JsonDistributionConfigurationStore(resolve(layout.configDir,"distribution.json"));
    this.control=new SqliteControlPlaneStore(layout.databasePath);
    this.surfaces=new SqlitePlatformSurfaceStore(layout.databasePath);
    this.registry=new PlatformSurfaceRegistryService(this.surfaces);
    const resolver=new BrowserProfileDirectoryResolver(layout.profilesDir),locks=new DurableBrowserProfileLockAdapter(this.control,new FileBrowserProfileLockAdapter(resolver));
    const runtime=new ChromiumCdpRuntimeAdapter({profilesRoot:layout.profilesDir,executablePath:options.chromiumExecutablePath??resolveChromiumExecutablePath()});
    this.bootstrap=new BrowserBootstrapService(this.control,runtime,locks);
  }

  private routeContext(routeId:string){
    const stored=this.config.load(),route=stored.config.routes.find(item=>item.routeId===routeId);if(!route||!route.enabled)throw new Error(`Route ${routeId} is missing or disabled`);
    const profile=stored.config.postingProfiles.find(item=>item.postingProfileId===route.postingProfileId);if(!profile||!profile.enabled)throw new Error(`Route ${routeId} posting profile is missing or disabled`);
    const account=this.control.getSocialAccount(route.accountId)?.account;if(!account||!account.enabled)throw new Error(`Route ${routeId} social account is missing or disabled`);
    const identities=this.control.listBrowserIdentities().map(item=>item.identity).filter(item=>item.accountId===route.accountId&&item.enabled);if(identities.length!==1)throw new Error(`Route ${routeId} requires exactly one enabled browser identity; found ${identities.length}`);
    return{route,profile,account,identity:identities[0]!};
  }
  private active(routeId:string){const active=this.sessions.get(routeId);if(!active)throw new Error(`Calibration browser for ${routeId} is not open`);return active;}

  status(routeId:string):SurfaceCalibrationRouteStatus{
    const {route,profile}=this.routeContext(routeId),recipe=surfaceRecipeForPostingProfile(profile),observations=this.surfaces.listObservations(route.accountId,profile.platform,profile.format),latest=this.surfaces.latestContract(route.accountId,profile.postingProfileId),replays=latest?this.surfaces.listReplays(latest.contract.contractId):[],active=this.sessions.get(routeId);
    const latestFingerprint=observations.slice().sort((a,b)=>a.observedAt.localeCompare(b.observedAt)).at(-1)?.environment.fingerprint;
    const currentObservations=latestFingerprint?observations.filter(item=>item.environment.fingerprint===latestFingerprint):[];
    const lastThree=replays.slice(-3),replayPasses=lastThree.filter(item=>item.passed&&item.reachedFinalActionBoundary&&!item.finalActionInvoked&&(!latest||item.environmentFingerprint===latest.contract.environment.fingerprint)).length;
    return{routeId,accountId:route.accountId,postingProfileId:profile.postingProfileId,platform:profile.platform,format:profile.format,browserOpen:Boolean(active),contractStatus:latest?.contract.status??"MISSING",...(latest?{contractId:latest.contract.contractId}:{}),replayPasses,steps:recipe.steps.map(step=>({stepKey:step.stepKey,label:step.label,actionMode:step.actionMode,required:step.required,observations:currentObservations.filter(item=>item.stepKey===step.stepKey).length,armed:active?.armedStep===step.stepKey,...(step.stepKey==="UPLOAD_MEDIA"?{specialCapture:"FILE_INPUT" as const}:{})}))};
  }

  async openBrowser(routeId:string,now:string):Promise<void>{
    if(this.sessions.has(routeId))return;
    const {route,account,identity}=this.routeContext(routeId);
    if(identity.platform!==account.platform||account.platform!==route.platform)throw new Error(`Route ${routeId} account/identity platform mismatch`);
    const session=await this.bootstrap.openForOperator({identityId:identity.identityId,ownerId:`surface-calibration:${routeId}`,bootstrapUrl:bootstrapUrl(route.platform),now:new Date(now).toISOString(),headless:false});
    this.sessions.set(routeId,{session,armedStep:null});
  }
  async closeBrowser(routeId:string):Promise<void>{const active=this.sessions.get(routeId);if(!active)return;this.sessions.delete(routeId);await active.session.close();}

  async armStep(routeId:string,stepKey:string):Promise<void>{
    const {profile}=this.routeContext(routeId),definition=surfaceRecipeForPostingProfile(profile).steps.find(item=>item.stepKey===stepKey);if(!definition)throw new Error(`Unknown calibration step ${stepKey}`);
    if(stepKey==="UPLOAD_MEDIA")throw new Error("UPLOAD_MEDIA uses read-only file-input capture; do not arm a visible upload button");
    const active=this.active(routeId);await this.recorder.arm(active.session.page,stepKey,definition.actionMode);active.armedStep=stepKey;
  }
  async captureStep(routeId:string,stepKey:string,now:string){
    const {route,profile}=this.routeContext(routeId),definition=surfaceRecipeForPostingProfile(profile).steps.find(item=>item.stepKey===stepKey);if(!definition)throw new Error(`Unknown calibration step ${stepKey}`);
    const active=this.active(routeId),at=new Date(now).toISOString();
    const observation=stepKey==="UPLOAD_MEDIA"
      ?await this.recorder.readUniqueFileInputObservation(active.session.page,{accountId:route.accountId,platform:profile.platform,format:profile.format,stepKey,observedAt:at})
      :active.armedStep===stepKey
        ?await this.recorder.readObservation(active.session.page,{accountId:route.accountId,platform:profile.platform,format:profile.format,stepKey,observedAt:at})
        :(()=>{throw new Error(`Calibration step ${stepKey} is not armed`);})();
    this.registry.recordObservation(observation);await this.recorder.clear(active.session.page);active.armedStep=null;return observation;
  }
  buildRecordedContract(routeId:string,now:string):string{const {route,profile}=this.routeContext(routeId);return this.registry.buildRecorded(route.accountId,profile,new Date(now).toISOString()).contract.contractId;}

  async close():Promise<void>{const routes=[...this.sessions.keys()];for(const routeId of routes)await this.closeBrowser(routeId).catch(()=>{});this.surfaces.close();this.control.close();}
}
