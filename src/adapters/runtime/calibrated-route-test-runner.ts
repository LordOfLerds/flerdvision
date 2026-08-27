import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { SessionProbePort } from "../../domain/browser-identity-ports.js";
import type { DistributionConfigurationStorePort } from "../../domain/distribution-ports.js";
import type { DistributionRuntimeStateStorePort } from "../../domain/distribution-runtime-ports.js";
import type { PublicationIntent, PublishAttempt } from "../../domain/model.js";
import type { PublicationPayload } from "../../domain/platform-ui.js";
import type { PublicationPayloadResolverPort } from "../../domain/platform-ui-ports.js";
import type { CapabilityAwareRouteTestExecutionAdapterPort, RouteTestCommandCapability } from "../../domain/route-test-command-ports.js";
import type { ExecutableRouteTestKey } from "../../domain/route-test-ports.js";
import { PlatformPreparationCoordinator } from "../../application/platform-preparation.js";
import { workspaceRuntimeLayout } from "../../application/workspaces.js";
import { ChromiumCdpRuntimeAdapter } from "../browser/chromium-cdp.js";
import { ConfiguredDomSessionProbe } from "../browser/configured-dom-probe.js";
import { LocalPrepareArtifactSink } from "../browser/prepare-artifacts.js";
import { BrowserProfileDirectoryResolver, DurableBrowserProfileLockAdapter, FileBrowserProfileLockAdapter } from "../browser/profile-lock.js";
import { resolveChromiumExecutablePath } from "../browser/resolve-chromium.js";
import { calibratedSessionProbeFor, loadSessionProbeConfigFile } from "../browser/session-probe-config.js";
import { workspaceDriveAccessTokenProvider } from "../ingress/google-drive/workspace-drive-token.js";
import { DeclarativePlatformUiAdapter } from "../publish/declarative-platform-ui.js";
import { loadPlatformUiSpecFile } from "../publish/platform-spec-config.js";
import { WorkspaceMediaMaterializer } from "../publish/workspace-media-materializer.js";
import { SqliteControlPlaneStore } from "../storage/sqlite.js";
import { LocalVerificationArtifactSink } from "../verify/artifacts.js";
import { DeclarativeProfileVerificationCollector } from "../verify/profile.js";
import { calibratedProfileVerificationSpecFor, loadProfileVerificationSpecFile } from "../verify/profile-spec-config.js";
import { SafeObserverRouteTestRunner } from "./safe-route-test-runner.js";

class RouteTestPayloadResolver implements PublicationPayloadResolverPort {
  async resolve(intent:PublicationIntent):Promise<PublicationPayload>{
    return{copyVersionId:intent.copyVersionId,caption:"[PREPARE_ONLY TEST]",title:"Flerdvision PREPARE_ONLY Test",description:"Flerdvision route qualification; final publish is disabled."};
  }
}

export class CalibratedWorkspaceRouteTestRunner implements CapabilityAwareRouteTestExecutionAdapterPort {
  private readonly layout:ReturnType<typeof workspaceRuntimeLayout>;
  private readonly platformUiPath:string;
  private readonly sessionProbePath:string;
  private readonly verificationPath:string;

  constructor(
    private readonly safe:SafeObserverRouteTestRunner,
    private readonly config:DistributionConfigurationStorePort,
    private readonly control:SqliteControlPlaneStore,
    private readonly runtime:DistributionRuntimeStateStorePort,
    runtimeRoot:string,
    workspaceId:string,
    private readonly releaseSha:string,
    private readonly chromiumExecutablePath?:string
  ){
    this.layout=workspaceRuntimeLayout(resolve(runtimeRoot),workspaceId);
    this.platformUiPath=resolve(this.layout.configDir,"platform-ui.json");
    this.sessionProbePath=resolve(this.layout.configDir,"session-probes.json");
    this.verificationPath=resolve(this.layout.configDir,"profile-verification.json");
  }

  private profile(routeId:string){const stored=this.config.load(),route=stored.config.routes.find(item=>item.routeId===routeId);if(!route)throw new Error(`Unknown route: ${routeId}`);const profile=stored.config.postingProfiles.find(item=>item.postingProfileId===route.postingProfileId);if(!profile||!profile.enabled)throw new Error(`Route ${routeId} posting profile is missing or disabled`);const copy=stored.config.copyProfiles.find(item=>item.copyProfileId===route.copyProfileId);if(!copy||!copy.enabled)throw new Error(`Route ${routeId} copy profile is missing or disabled`);const lane=stored.config.lanes.find(item=>item.laneId===route.laneId);if(!lane||!lane.enabled)throw new Error(`Route ${routeId} lane is missing or disabled`);return{route,profile,copy,lane};}
  private identity(accountId:string){const identities=this.control.listBrowserIdentities().map(item=>item.identity).filter(item=>item.accountId===accountId&&item.enabled);if(identities.length!==1)throw new Error(`Account ${accountId} requires exactly one enabled browser identity; found ${identities.length}`);return identities[0]!;}
  private probe(accountId:string,platform:PublicationIntent["platform"]){if(!existsSync(this.sessionProbePath))throw new Error("workspace config/session-probes.json is missing");const entry=calibratedSessionProbeFor(loadSessionProbeConfigFile(this.sessionProbePath),accountId,platform);if(!entry)throw new Error(`no calibrated session probe for ${platform}/${accountId}`);return entry;}
  private uiSpec(platform:PublicationIntent["platform"],format:PublicationIntent["format"]){if(!existsSync(this.platformUiPath))throw new Error("workspace config/platform-ui.json is missing");const matches=loadPlatformUiSpecFile(this.platformUiPath,false).specs.filter(item=>item.platform===platform&&item.calibrationStatus==="CALIBRATED"&&item.spec.supportedFormats.includes(format));if(matches.length!==1)throw new Error(`Expected exactly one calibrated ${platform}/${format} UI spec; found ${matches.length}`);return matches[0]!;}
  private verificationSpec(accountId:string,platform:PublicationIntent["platform"]){if(!existsSync(this.verificationPath))throw new Error("workspace config/profile-verification.json is missing");const entry=calibratedProfileVerificationSpecFor(loadProfileVerificationSpecFile(this.verificationPath),accountId,platform);if(!entry)throw new Error(`no calibrated profile verification spec for ${platform}/${accountId}`);return entry;}
  private readyAsset(routeId:string){const {route}=this.profile(routeId);const assets=this.runtime.listAssets().map(item=>item.asset).filter(item=>item.laneId===route.laneId&&item.state==="READY").sort((a,b)=>a.observedAt.localeCompare(b.observedAt));if(assets.length===0)throw new Error(`Route ${routeId} has no READY asset in lane ${route.laneId}`);return assets[0]!;}
  private syntheticIntent(routeId:string,withRealAsset:boolean):PublicationIntent{
    const {route,profile,copy,lane}=this.profile(routeId);const now=new Date().toISOString();const asset=withRealAsset?this.readyAsset(routeId):null;
    return{intentId:`route-test:${route.routeId}:${asset?.assetId??"verification"}:${this.releaseSha.slice(0,12)}`,contentId:asset?.contentId??`route-test-content:${route.routeId}`,creatorId:asset?.creatorId??lane.creatorId??`route-test:${route.laneId}`,platform:route.platform,accountId:route.accountId,format:profile.format,copyVersionId:copy.versionId,scheduledFor:now,idempotencyKey:`route-test:${route.routeId}:${asset?.assetId??"verification"}:${this.releaseSha}`};
  }
  private browser(){const resolver=new BrowserProfileDirectoryResolver(this.layout.profilesDir);const locks=new DurableBrowserProfileLockAdapter(this.control,new FileBrowserProfileLockAdapter(resolver));const runtime=new ChromiumCdpRuntimeAdapter({profilesRoot:this.layout.profilesDir,executablePath:this.chromiumExecutablePath??resolveChromiumExecutablePath()});return{runtime,locks};}
  private capability(routeId:string,testKey:"PREPARE_ONLY"|"VERIFICATION"):RouteTestCommandCapability{
    try{const {route,profile}=this.profile(routeId);this.identity(route.accountId);this.probe(route.accountId,route.platform);if(testKey==="PREPARE_ONLY"){this.uiSpec(route.platform,profile.format);this.readyAsset(routeId);return{testKey,executable:true,reason:"Calibrated UI + session probe + READY lane asset available; final action remains physically disabled."};}this.verificationSpec(route.accountId,route.platform);return{testKey,executable:true,reason:"Calibrated profile verification surface + session probe available."};}catch(error){return{testKey,executable:false,reason:error instanceof Error?error.message:String(error)};}
  }

  capabilities(routeId:string):readonly RouteTestCommandCapability[]{
    const base=this.safe.capabilities(routeId).filter(item=>item.testKey!=="PREPARE_ONLY"&&item.testKey!=="VERIFICATION"&&item.testKey!=="CLEANUP");
    return[...base,this.capability(routeId,"PREPARE_ONLY"),this.capability(routeId,"VERIFICATION"),{testKey:"CLEANUP",executable:false,reason:"Cleanup is allowed only after canonical SECRET_LIVE private E2E evidence; it stays outside the generic safe runner."}];
  }

  async run(routeId:string,testKey:ExecutableRouteTestKey):Promise<{passed:boolean;summary:string;artifactRefs:readonly string[]}>{
    if(testKey==="SOURCE"||testKey==="SESSION"||testKey==="IDENTITY"||testKey==="SURFACE")return await this.safe.run(routeId,testKey);
    if(testKey==="CLEANUP")throw new Error("CLEANUP requires canonical private E2E evidence");
    if(testKey==="PREPARE_ONLY")return await this.prepareOnly(routeId);
    return await this.verify(routeId);
  }

  private async prepareOnly(routeId:string){
    const intent=this.syntheticIntent(routeId,true),probeEntry=this.probe(intent.accountId,intent.platform),specEntry=this.uiSpec(intent.platform,intent.format),{runtime,locks}=this.browser();
    const drive=workspaceDriveAccessTokenProvider({configDir:this.layout.configDir});
    const sessionProbes:Partial<Record<PublicationIntent["platform"],SessionProbePort>>={};
    sessionProbes[intent.platform]=new ConfiguredDomSessionProbe(probeEntry.config);
    const coordinator=new PlatformPreparationCoordinator(this.control,runtime,locks,sessionProbes,new RouteTestPayloadResolver(),new WorkspaceMediaMaterializer(this.config,drive,resolve(this.layout.mediaCacheDir,"route-tests")),new LocalPrepareArtifactSink(resolve(this.layout.evidenceDir,"route-tests","prepare")),[new DeclarativePlatformUiAdapter(specEntry.spec)],{releaseSha:this.releaseSha,ownerId:`route-test:prepare:${routeId}`,headless:true});
    const prepared=await coordinator.open(intent);
    try{return{passed:Boolean(prepared.attempt.reachedFinalActionBoundary&&prepared.attempt.result==="prepared"),summary:`PREPARE_ONLY reached final-action boundary for ${intent.platform}/${intent.format}; no irreversible action was invoked.`,artifactRefs:[...(prepared.attempt.preparationArtifactRefs??[])]};}
    finally{await prepared.close();}
  }

  private async verify(routeId:string){
    const intent=this.syntheticIntent(routeId,false),probeEntry=this.probe(intent.accountId,intent.platform),verification=this.verificationSpec(intent.accountId,intent.platform),identity=this.identity(intent.accountId),{runtime,locks}=this.browser(),now=new Date().toISOString();
    const attempt:PublishAttempt={attemptId:`route-test-verification:${routeId}:${this.releaseSha.slice(0,12)}`,intentId:intent.intentId,browserIdentityId:identity.identityId,releaseSha:this.releaseSha,startedAt:now,finishedAt:now,result:"prepared",reachedFinalActionBoundary:true};
    const collector=new DeclarativeProfileVerificationCollector(this.control,runtime,locks,new ConfiguredDomSessionProbe(probeEntry.config),new LocalVerificationArtifactSink(resolve(this.layout.evidenceDir,"route-tests","verification")),verification.spec,{ownerId:`route-test:verification:${routeId}`,headless:true});
    const evidence=await collector.collect(intent,attempt);const refs=evidence.flatMap(item=>item.artifactRef?[item.artifactRef]:[]);
    return{passed:evidence.length>0,summary:`Verification surface executed for ${intent.platform}; ${evidence.length} evidence record(s), positive=${evidence.filter(item=>item.positive).length}, negative=${evidence.filter(item=>!item.positive).length}.`,artifactRefs:refs};
  }
}
