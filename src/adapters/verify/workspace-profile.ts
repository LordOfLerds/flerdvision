import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { BrowserIdentityStorePort, BrowserProfileLockPort, BrowserRuntimePort } from "../../domain/browser-identity-ports.js";
import type { PublicationIntent, PublishAttempt, VerificationEvidence } from "../../domain/model.js";
import type { ExpectedPublicationCopyPort, VerificationEvidenceCollectorPort } from "../../domain/verification-ports.js";
import { ConfiguredDomSessionProbe } from "../browser/configured-dom-probe.js";
import { calibratedSessionProbeFor, loadSessionProbeConfigFile } from "../browser/session-probe-config.js";
import { DeclarativeProfileVerificationCollector } from "./profile.js";
import { calibratedProfileVerificationSpecFor, loadProfileVerificationSpecFile } from "./profile-spec-config.js";
import type { VerificationArtifactSinkPort } from "../../domain/verification-ports.js";

/** Resolves the calibrated session + profile verification contract per intent at collection time. */
export class WorkspaceProfileVerificationCollector implements VerificationEvidenceCollectorPort {
  readonly name="workspace_profile_verification";
  constructor(
    private readonly store:BrowserIdentityStorePort,
    private readonly browser:BrowserRuntimePort,
    private readonly locks:BrowserProfileLockPort,
    private readonly artifacts:VerificationArtifactSinkPort,
    private readonly configDir:string,
    private readonly ownerId:string,
    private readonly headless=true,
    private readonly now:()=>string=()=>new Date().toISOString(),
    /** Required for marker-free routes: the copy the run posted, resolved like the publisher did. */
    private readonly expectedCopy?:ExpectedPublicationCopyPort
  ){}
  async collect(intent:PublicationIntent,attempt:PublishAttempt):Promise<readonly VerificationEvidence[]>{
    const sessionPath=resolve(this.configDir,"session-probes.json"),profilePath=resolve(this.configDir,"profile-verification.json");
    if(!existsSync(sessionPath))throw new Error(`Workspace session-probes.json is missing: ${sessionPath}`);
    if(!existsSync(profilePath))throw new Error(`Workspace profile-verification.json is missing: ${profilePath}`);
    const probeEntry=calibratedSessionProbeFor(loadSessionProbeConfigFile(sessionPath),intent.accountId,intent.platform);if(!probeEntry)throw new Error(`No CALIBRATED session probe for ${intent.platform}/${intent.accountId}`);
    const profileEntry=calibratedProfileVerificationSpecFor(loadProfileVerificationSpecFile(profilePath),intent.accountId,intent.platform);if(!profileEntry)throw new Error(`No CALIBRATED profile verification contract for ${intent.platform}/${intent.accountId}`);
    const collector=new DeclarativeProfileVerificationCollector(this.store,this.browser,this.locks,new ConfiguredDomSessionProbe(probeEntry.config),this.artifacts,profileEntry.spec,{ownerId:this.ownerId,headless:this.headless,now:this.now,...(this.expectedCopy?{expectedCopy:this.expectedCopy}:{})});
    return await collector.collect(intent,attempt);
  }
}
