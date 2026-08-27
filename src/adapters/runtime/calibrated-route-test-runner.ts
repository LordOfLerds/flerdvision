import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { AccountIdentityGuard, BrowserSessionHealthService } from "../../application/browser-identity-service.js";
import { buildCalibrationReplayPlan } from "../../application/platform-execution-plan.js";
import { PlatformSurfaceRegistryService } from "../../application/platform-surface-registry.js";
import { workspaceRuntimeLayout } from "../../application/workspaces.js";
import type { DistributionPostingContext } from "../../domain/distribution-publish-ports.js";
import type { DistributionConfigurationStorePort } from "../../domain/distribution-ports.js";
import type { DistributionRuntimeStateStorePort } from "../../domain/distribution-runtime-ports.js";
import type { PlatformSurfaceStorePort } from "../../domain/platform-surface-ports.js";
import type { PublicationIntent, PublishAttempt } from "../../domain/model.js";
import type { CapabilityAwareRouteTestExecutionAdapterPort, RouteTestCommandCapability } from "../../domain/route-test-command-ports.js";
import type { ExecutableRouteTestKey } from "../../domain/route-test-ports.js";
import { ChromiumCdpRuntimeAdapter } from "../browser/chromium-cdp.js";
import { ConfiguredDomSessionProbe } from "../browser/configured-dom-probe.js";
import { LocalPrepareArtifactSink } from "../browser/prepare-artifacts.js";
import { SafePlatformExecutionRunner } from "../browser/platform-execution-runner.js";
import { BrowserProfileDirectoryResolver, DurableBrowserProfileLockAdapter, FileBrowserProfileLockAdapter } from "../browser/profile-lock.js";
import { resolveChromiumExecutablePath } from "../browser/resolve-chromium.js";
import { calibratedSessionProbeFor, loadSessionProbeConfigFile } from "../browser/session-probe-config.js";
import { workspaceDriveAccessTokenProvider } from "../ingress/google-drive/workspace-drive-token.js";
import { WorkspaceMediaMaterializer } from "../publish/workspace-media-materializer.js";
import { SqliteControlPlaneStore } from "../storage/sqlite.js";
import { LocalVerificationArtifactSink } from "../verify/artifacts.js";
import { DeclarativeProfileVerificationCollector } from "../verify/profile.js";
import { calibratedProfileVerificationSpecFor, loadProfileVerificationSpecFile } from "../verify/profile-spec-config.js";
import { SafeObserverRouteTestRunner } from "./safe-route-test-runner.js";

export class CalibratedWorkspaceRouteTestRunner implements CapabilityAwareRouteTestExecutionAdapterPort {
  private readonly layout:ReturnType<typeof workspaceRuntimeLayout>;
  private readonly sessionProbePath:string;
  private readonly verificationPath:string;

  constructor(
    private readonly safe:SafeObserverRouteTestRunner,
    private readonly config:DistributionConfigurationStorePort,
    private readonly control:SqliteControlPlaneStore,
    private readonly runtime:DistributionRuntimeStateStorePort,
    private readonly surfaces:PlatformSurfaceStorePort,
    runtimeRoot:string,
    workspaceId:string,
    private readonly releaseSha:string,
    private readonly env:Record<string,string|undefined>=process.env,
    private readonly chromiumExecutablePath?:string
  ){
    this.layout=workspaceRuntimeLayout(resolve(runtimeRoot),workspaceId);
    this.sessionProbePath=resolve(this.layout.configDir,"session-probes.json");
    this.verificationPath=resolve(this.layout.configDir,"profile-verification.json");
  }

  private profile(routeId:string){
    const stored=this.config.load(),route=stored.config.routes.find(item=>item.routeId===routeId);
    if(!route)throw new Error(`Unknown route: ${routeId}`);
    const profile=stored.config.postingProfiles.find(item=>item.postingProfileId===route.postingProfileId);
    if(!profile||!profile.enabled)throw new Error(`Route ${routeId} posting profile is missing or disabled`);
    const copy=stored.config.copyProfiles.find(item=>item.copyProfileId===route.copyProfileId);
    if(!copy||!copy.enabled)throw new Error(`Route ${routeId} copy profile is missing or disabled`);
    const lane=stored.config.lanes.find(item=>item.laneId===route.laneId);
    if(!lane||!lane.enabled)throw new Error(`Route ${routeId} lane is missing or disabled`);
    return{route,profile,copy,lane};
  }
  private identity(accountId:string){
    const identities=this.control.listBrowserIdentities().map(item=>item.identity).filter(item=>item.accountId===accountId&&item.enabled);
    if(identities.length!==1)throw new Error(`Account ${accountId} requires exactly one enabled browser identity; found ${identities.length}`);
    return identities[0]!;
  }
  private probe(accountId:string,platform:PublicationIntent["platform"]){
    if(!existsSync(this.sessionProbePath))throw new Error("workspace config/session-probes.json is missing");
    const entry=calibratedSessionProbeFor(loadSessionProbeConfigFile(this.sessionProbePath),accountId,platform);
    if(!entry)throw new Error(`no calibrated session probe for ${platform}/${accountId}`);
    return entry;
  }
  private verificationSpec(accountId:string,platform:PublicationIntent["platform"]){
    if(!existsSync(this.verificationPath))throw new Error("workspace config/profile-verification.json is missing");
    const entry=calibratedProfileVerificationSpecFor(loadProfileVerificationSpecFile(this.verificationPath),accountId,platform);
    if(!entry)throw new Error(`no calibrated profile verification spec for ${platform}/${accountId}`);
    return entry;
  }
  private readyAsset(routeId:string){
    const {route}=this.profile(routeId);
    const assets=this.runtime.listAssets().map(item=>item.asset).filter(item=>item.laneId===route.laneId&&item.state==="READY").sort((a,b)=>a.observedAt.localeCompare(b.observedAt));
    if(assets.length===0)throw new Error(`Route ${routeId} has no READY asset in lane ${route.laneId}`);
    return assets[0]!;
  }
  private surface(routeId:string){
    const {route}=this.profile(routeId),surface=this.surfaces.latestContract(route.accountId,route.postingProfileId);
    if(!surface)throw new Error(`Route ${routeId} has no recorded surface contract; capture the calibration recipe first`);
    return surface;
  }
  private postingContext(routeId:string):DistributionPostingContext{
    const {route,profile,copy}=this.profile(routeId),asset=this.readyAsset(routeId),now=new Date().toISOString();
    const intent:PublicationIntent={
      intentId:`route-test:${route.routeId}:${asset.assetId}:${this.releaseSha.slice(0,12)}`,
      contentId:asset.contentId,creatorId:asset.creatorId,platform:route.platform,accountId:route.accountId,format:profile.format,copyVersionId:copy.versionId,scheduledFor:now,
      idempotencyKey:`route-test:${route.routeId}:${asset.assetId}:${this.releaseSha}`
    };
    return{intent,postingProfile:profile,provenance:{
      planId:`route-test-plan:${route.routeId}:${this.releaseSha.slice(0,12)}`,
      deliveryId:`route-test-delivery:${route.routeId}:${asset.assetId}`,
      routeId:route.routeId,laneId:route.laneId,assetId:asset.assetId,postingProfileId:route.postingProfileId,copyProfileId:route.copyProfileId,
      schedulePolicyId:route.schedulePolicyId,routeSnapshotFingerprint:`surface-replay:${route.routeId}:${this.releaseSha}`,postingProfileSnapshot:profile
    }};
  }
  private syntheticVerificationIntent(routeId:string):PublicationIntent{
    const {route,profile,copy,lane}=this.profile(routeId),now=new Date().toISOString();
    return{intentId:`route-test:${route.routeId}:verification:${this.releaseSha.slice(0,12)}`,contentId:`route-test-content:${route.routeId}`,creatorId:lane.creatorId??`route-test:${route.laneId}`,platform:route.platform,accountId:route.accountId,format:profile.format,copyVersionId:copy.versionId,scheduledFor:now,idempotencyKey:`route-test:${route.routeId}:verification:${this.releaseSha}`};
  }
  private browser(){
    const resolver=new BrowserProfileDirectoryResolver(this.layout.profilesDir),locks=new DurableBrowserProfileLockAdapter(this.control,new FileBrowserProfileLockAdapter(resolver));
    const runtime=new ChromiumCdpRuntimeAdapter({profilesRoot:this.layout.profilesDir,executablePath:this.chromiumExecutablePath??this.env.CHROMIUM_EXECUTABLE_PATH??resolveChromiumExecutablePath()});
    return{runtime,locks};
  }
  private capability(routeId:string,testKey:"PREPARE_ONLY"|"VERIFICATION"):RouteTestCommandCapability{
    try{
      const {route}=this.profile(routeId);this.identity(route.accountId);this.probe(route.accountId,route.platform);
      if(testKey==="PREPARE_ONLY"){
        this.readyAsset(routeId);const surface=this.surface(routeId),replays=this.surfaces.listReplays(surface.contract.contractId);
        const detail=surface.contract.status==="RECORDED"?`Calibration replay ${Math.min(3,replays.slice(-3).filter(item=>item.passed&&item.reachedFinalActionBoundary&&!item.finalActionInvoked).length)}/3; the recorded SurfaceContract is the execution source.`:`Surface ${surface.contract.contractId} is CALIBRATED; prepare-only uses the canonical SurfaceContract.`;
        return{testKey,executable:true,reason:detail};
      }
      this.verificationSpec(route.accountId,route.platform);
      return{testKey,executable:true,reason:"Calibrated profile verification surface + session probe available."};
    }catch(error){return{testKey,executable:false,reason:error instanceof Error?error.message:String(error)};}
  }

  capabilities(routeId:string):readonly RouteTestCommandCapability[]{
    const base=this.safe.capabilities(routeId).filter(item=>item.testKey!=="PREPARE_ONLY"&&item.testKey!=="VERIFICATION"&&item.testKey!=="CLEANUP");
    return[...base,this.capability(routeId,"PREPARE_ONLY"),this.capability(routeId,"VERIFICATION"),{testKey:"CLEANUP",executable:false,reason:"Cleanup is allowed only after canonical SECRET_LIVE private E2E evidence; it stays outside the generic safe runner."}];
  }

  async run(routeId:string,testKey:ExecutableRouteTestKey,checkedAt?:string):Promise<{passed:boolean;summary:string;artifactRefs:readonly string[]}>{
    if(testKey==="SOURCE"||testKey==="SESSION"||testKey==="IDENTITY"||testKey==="SURFACE")return await this.safe.run(routeId,testKey);
    if(testKey==="CLEANUP")throw new Error("CLEANUP requires canonical private E2E evidence");
    if(testKey==="PREPARE_ONLY")return await this.prepareOnly(routeId,checkedAt);
    return await this.verify(routeId,checkedAt);
  }

  private async prepareOnly(routeId:string,checkedAt?:string){
    const at=new Date(checkedAt??new Date().toISOString()).toISOString(),context=this.postingContext(routeId),surface=this.surface(routeId),identity=this.identity(context.intent.accountId),probeEntry=this.probe(context.intent.accountId,context.intent.platform),{runtime,locks}=this.browser();
    const ownerId=`route-test:prepare:${routeId}`,actor={type:"worker" as const,id:ownerId},lock=locks.acquire(identity,ownerId,at);
    const drive=workspaceDriveAccessTokenProvider({configDir:this.layout.configDir,env:this.env}),materializer=new WorkspaceMediaMaterializer(this.config,drive,resolve(this.layout.mediaCacheDir,"route-tests"));
    let session:Awaited<ReturnType<typeof runtime.launch>>|undefined,media:Awaited<ReturnType<typeof materializer.materialize>>|undefined;
    try{
      session=await runtime.launch(identity,{headless:true,initialUrl:"about:blank"});
      await new BrowserSessionHealthService(this.control,new ConfiguredDomSessionProbe(probeEntry.config)).check(identity.identityId,session,at,actor);
      new AccountIdentityGuard(this.control).assertReady(identity.identityId);
      const content=this.control.getContentItem(context.intent.contentId)?.item;if(!content)throw new Error(`Content item not found for READY asset: ${context.intent.contentId}`);
      media=await materializer.materialize(content);
      const plan=buildCalibrationReplayPlan(context,surface.contract),artifacts=new LocalPrepareArtifactSink(resolve(this.layout.evidenceDir,"route-tests","surface-replays"));let tick=0;
      const execution=await new SafePlatformExecutionRunner(session,artifacts,()=>new Date(new Date(at).getTime()+tick++).toISOString()).execute(plan,identity,{mediaPath:media.localPath,caption:"[PREPARE_ONLY TEST]",title:"Flerdvision PREPARE_ONLY Test"});
      const passed=execution.environmentFingerprint===surface.contract.environment.fingerprint,registry=new PlatformSurfaceRegistryService(this.surfaces),ordinal=this.surfaces.listReplays(surface.contract.contractId).length+1;
      registry.recordReplay({replayId:`surface-replay:${surface.contract.contractId}:${ordinal}`,contractId:surface.contract.contractId,checkedAt:at,passed,reachedFinalActionBoundary:true,finalActionInvoked:false,environmentFingerprint:execution.environmentFingerprint,artifactRefs:[...execution.artifactRefs]});
      let promoted=false,stale=false;const replays=this.surfaces.listReplays(surface.contract.contractId),lastThree=replays.slice(-3),latest=this.surfaces.latestContract(context.intent.accountId,context.postingProfile.postingProfileId);
      if(surface.contract.status==="RECORDED"&&lastThree.length===3&&lastThree.every(item=>item.passed&&item.reachedFinalActionBoundary&&!item.finalActionInvoked&&item.environmentFingerprint===surface.contract.environment.fingerprint)){
        if(latest?.contract.contractId===surface.contract.contractId){registry.qualify(context.intent.accountId,context.postingProfile,at);promoted=true;}
        else stale=true;
      }
      const current=this.surfaces.latestContract(context.intent.accountId,context.postingProfile.postingProfileId)?.contract.status??surface.contract.status;
      return{passed,summary:`PREPARE_ONLY replay reached final boundary from canonical SurfaceContract; final action invoked=false; environment=${passed?"MATCH":"MISMATCH"}; surface=${promoted?"PROMOTED_TO_CALIBRATED":stale?"STALE_REPLAY_NOT_PROMOTED":current}.`,artifactRefs:[...execution.artifactRefs]};
    }finally{
      if(media)await materializer.release(media).catch(()=>{});
      if(session)await session.close().catch(()=>{});
      lock.release();
    }
  }

  private async verify(routeId:string,checkedAt?:string){
    const intent=this.syntheticVerificationIntent(routeId),probeEntry=this.probe(intent.accountId,intent.platform),verification=this.verificationSpec(intent.accountId,intent.platform),identity=this.identity(intent.accountId),{runtime,locks}=this.browser(),now=new Date(checkedAt??new Date().toISOString()).toISOString();
    const attempt:PublishAttempt={attemptId:`route-test-verification:${routeId}:${this.releaseSha.slice(0,12)}`,intentId:intent.intentId,browserIdentityId:identity.identityId,releaseSha:this.releaseSha,startedAt:now,finishedAt:now,result:"prepared",reachedFinalActionBoundary:true};
    const collector=new DeclarativeProfileVerificationCollector(this.control,runtime,locks,new ConfiguredDomSessionProbe(probeEntry.config),new LocalVerificationArtifactSink(resolve(this.layout.evidenceDir,"route-tests","verification")),verification.spec,{ownerId:`route-test:verification:${routeId}`,headless:true,now:()=>now});
    const evidence=await collector.collect(intent,attempt),refs=evidence.flatMap(item=>item.artifactRef?[item.artifactRef]:[]);
    return{passed:evidence.length>0,summary:`Verification surface executed for ${intent.platform}; ${evidence.length} evidence record(s), positive=${evidence.filter(item=>item.positive).length}, negative=${evidence.filter(item=>!item.positive).length}.`,artifactRefs:refs};
  }
}
