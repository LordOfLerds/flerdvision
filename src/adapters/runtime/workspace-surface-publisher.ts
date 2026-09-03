import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DistributionPostingContextResolver } from "../../application/posting-context-resolver.js";
import { ReconciliationService } from "../../application/reconciliation.js";
import { workspaceRuntimeLayout } from "../../application/workspaces.js";
import type { PublicationIntent } from "../../domain/model.js";
import { CompositeReconciliationPolicy } from "../../domain/verification.js";
import { ChromiumCdpRuntimeAdapter } from "../browser/chromium-cdp.js";
import { ConfiguredDomSessionProbe } from "../browser/configured-dom-probe.js";
import { LocalPrepareArtifactSink } from "../browser/prepare-artifacts.js";
import { BrowserProfileDirectoryResolver, DurableBrowserProfileLockAdapter, FileBrowserProfileLockAdapter } from "../browser/profile-lock.js";
import { resolveChromiumExecutablePath } from "../browser/resolve-chromium.js";
import { calibratedSessionProbeFor, loadSessionProbeConfigFile } from "../browser/session-probe-config.js";
import { JsonDistributionConfigurationStore } from "../distribution/json-config-store.js";
import { SqliteDistributionProvenanceStore } from "../distribution/sqlite-provenance.js";
import { SqlitePlatformSurfaceStore } from "../distribution/sqlite-surface-store.js";
import { workspaceDriveAccessTokenProvider } from "../ingress/google-drive/workspace-drive-token.js";
import { WorkspaceMediaMaterializer } from "../publish/workspace-media-materializer.js";
import { WorkspacePublicationPayloadResolver } from "../publish/workspace-payload-resolver.js";
import { SqliteControlPlaneStore } from "../storage/sqlite.js";
import { LocalVerificationArtifactSink } from "../verify/artifacts.js";
import { WorkspaceProfileVerificationCollector } from "../verify/workspace-profile.js";
import { RetainedSurfaceFinalActionInvoker, RetainedSurfacePublishSessionRegistry, SurfacePublishPreparationService } from "./surface-publish-session.js";

export interface WorkspaceSurfacePublisherOptions {runtimeRoot:string;workspaceId:string;releaseSha:string;env?:Record<string,string|undefined>;chromiumExecutablePath?:string;ownerId?:string;headless?:boolean;now?:()=>string;}
/** Composition root shared by Private E2E and a future authorized runtime due worker. It never grants final-publish permission. */
export class WorkspaceSurfacePublisher {
  readonly registry=new RetainedSurfacePublishSessionRegistry();
  readonly prepare:SurfacePublishPreparationService;
  readonly finalAction:RetainedSurfaceFinalActionInvoker;
  /** Same resolver the publisher posts with, so operator messages can quote the copy as posted. */
  readonly payloads:WorkspacePublicationPayloadResolver;
  readonly reconciliation:ReconciliationService;
  private readonly control:SqliteControlPlaneStore;
  private readonly provenance:SqliteDistributionProvenanceStore;
  private readonly surfaces:SqlitePlatformSurfaceStore;

  constructor(options:WorkspaceSurfacePublisherOptions){
    if(!options.releaseSha.trim())throw new Error("Workspace Surface Publisher requires releaseSha");
    const env=options.env??process.env,layout=workspaceRuntimeLayout(resolve(options.runtimeRoot),options.workspaceId),sessionProbePath=resolve(layout.configDir,"session-probes.json"),payloadPath=resolve(layout.configDir,"copy-payloads.json"),ownerId=options.ownerId??`${options.workspaceId}:surface-publisher`,now=options.now??(()=>new Date().toISOString());
    if(!existsSync(sessionProbePath))throw new Error(`Workspace session-probes.json is missing: ${sessionProbePath}`);if(!existsSync(payloadPath))throw new Error(`Workspace copy-payloads.json is missing: ${payloadPath}`);
    const config=new JsonDistributionConfigurationStore(resolve(layout.configDir,"distribution.json"));
    this.control=new SqliteControlPlaneStore(layout.databasePath);this.provenance=new SqliteDistributionProvenanceStore(layout.databasePath);this.surfaces=new SqlitePlatformSurfaceStore(layout.databasePath);
    const context=new DistributionPostingContextResolver(this.provenance,config),resolver=new BrowserProfileDirectoryResolver(layout.profilesDir),locks=new DurableBrowserProfileLockAdapter(this.control,new FileBrowserProfileLockAdapter(resolver)),chromium=new ChromiumCdpRuntimeAdapter({profilesRoot:layout.profilesDir,executablePath:options.chromiumExecutablePath??env.CHROMIUM_EXECUTABLE_PATH??resolveChromiumExecutablePath()});
    const probe=(intent:PublicationIntent)=>{const entry=calibratedSessionProbeFor(loadSessionProbeConfigFile(sessionProbePath),intent.accountId,intent.platform);if(!entry)throw new Error(`No CALIBRATED session probe for ${intent.platform}/${intent.accountId}`);return new ConfiguredDomSessionProbe(entry.config);};
    const payloads=this.payloads=new WorkspacePublicationPayloadResolver(payloadPath,this.control),drive=workspaceDriveAccessTokenProvider({configDir:layout.configDir,env}),media=new WorkspaceMediaMaterializer(config,drive,resolve(layout.mediaCacheDir,"publisher")),prepareArtifacts=new LocalPrepareArtifactSink(resolve(layout.evidenceDir,"publisher"));
    this.prepare=new SurfacePublishPreparationService(this.control,context,this.surfaces,chromium,locks,probe,payloads,media,prepareArtifacts,this.registry,{releaseSha:options.releaseSha,ownerId,headless:options.headless??true,now});
    this.finalAction=new RetainedSurfaceFinalActionInvoker(this.registry,now);
    const verification=new WorkspaceProfileVerificationCollector(this.control,chromium,locks,new LocalVerificationArtifactSink(resolve(layout.evidenceDir,"verification")),layout.configDir,`${ownerId}:verification`,options.headless??true,now);
    this.reconciliation=new ReconciliationService(this.control,[verification],new CompositeReconciliationPolicy(),now);
  }

  async close():Promise<void>{await this.registry.closeAll();this.surfaces.close();this.provenance.close();this.control.close();}
}
