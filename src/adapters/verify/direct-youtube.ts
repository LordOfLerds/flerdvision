import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { AccountIdentityGuard, BrowserSessionHealthService } from "../../application/browser-identity-service.js";
import type { BrowserIdentityStorePort, BrowserProfileLockPort, BrowserRuntimePort } from "../../domain/browser-identity-ports.js";
import { normalizeSocialHandle } from "../../domain/browser-identity.js";
import type { PublicationIntent, PublishAttempt, VerificationEvidence } from "../../domain/model.js";
import { collapsePostedText } from "../../domain/platform-ui.js";
import type { ExpectedPublicationCopyPort, VerificationArtifactSinkPort, VerificationEvidenceCollectorPort, VerificationStorePort } from "../../domain/verification-ports.js";
import { ConfiguredDomSessionProbe } from "../browser/configured-dom-probe.js";
import { calibratedSessionProbeFor, loadSessionProbeConfigFile } from "../browser/session-probe-config.js";
import { calibratedProfileVerificationSpecFor, loadProfileVerificationSpecFile } from "./profile-spec-config.js";

type DirectYoutubeStore = BrowserIdentityStorePort & VerificationStorePort;

function evidenceId(intentId:string,attemptId:string,at:string):string{
  return `youtube-direct:${createHash("sha256").update(`${intentId}|${attemptId}|${at}`).digest("hex").slice(0,24)}`;
}

export function youtubeVideoIdFromLocator(locator:string|undefined):string|undefined{
  if(!locator)return undefined;
  let url:URL;
  try{url=new URL(locator);}catch{return undefined;}
  const host=url.hostname.toLocaleLowerCase("en-US").replace(/^www\./,"");
  let candidate:string|undefined;
  if(host==="youtu.be")candidate=url.pathname.split("/").filter(Boolean)[0];
  else if(host==="studio.youtube.com")candidate=/^\/video\/([^/?#]+)/.exec(url.pathname)?.[1];
  else if(host==="youtube.com"||host==="m.youtube.com"){
    candidate=/^\/shorts\/([^/?#]+)/.exec(url.pathname)?.[1];
    if(!candidate&&url.pathname==="/watch")candidate=url.searchParams.get("v")??undefined;
  }
  if(!candidate||!/^[A-Za-z0-9_-]{6,32}$/.test(candidate))return undefined;
  return candidate;
}

export function directYoutubeHint(evidence:readonly VerificationEvidence[],attempt:PublishAttempt):{videoId:string;sourceUrl:string}|undefined{
  const invokedAt=attempt.finalActionInvokedAt?new Date(attempt.finalActionInvokedAt).getTime():undefined;
  const candidates=evidence
    .filter(item=>item.kind==="ui_receipt"&&item.positive&&item.locator&&item.attemptId===attempt.attemptId)
    .filter(item=>invokedAt===undefined||new Date(item.observedAt).getTime()>=invokedAt)
    .sort((a,b)=>b.observedAt.localeCompare(a.observedAt));
  for(const item of candidates){
    const videoId=youtubeVideoIdFromLocator(item.locator);
    if(videoId)return{videoId,sourceUrl:item.locator!};
  }
  return undefined;
}

function ownerHandleFromHref(href:string):string|undefined{
  try{
    const url=new URL(href,"https://www.youtube.com");
    const segment=url.pathname.split("/").filter(Boolean).find(item=>item.startsWith("@"));
    return segment?normalizeSocialHandle(segment):undefined;
  }catch{return undefined;}
}

export class DirectYoutubeVerificationCollector implements VerificationEvidenceCollectorPort{
  readonly name="youtube_direct_object_verification";
  constructor(
    private readonly store:DirectYoutubeStore,
    private readonly browser:BrowserRuntimePort,
    private readonly locks:BrowserProfileLockPort,
    private readonly artifacts:VerificationArtifactSinkPort,
    private readonly configDir:string,
    private readonly ownerId:string,
    private readonly headless=true,
    private readonly now:()=>string=()=>new Date().toISOString(),
    private readonly expectedCopy?:ExpectedPublicationCopyPort
  ){}

  async collect(intent:PublicationIntent,attempt:PublishAttempt):Promise<readonly VerificationEvidence[]>{
    if(intent.platform!=="youtube")return[];
    const hint=directYoutubeHint(this.store.listVerificationEvidence(intent.intentId,attempt.attemptId),attempt);
    if(!hint)return[];
    if(!this.expectedCopy)return this.inconclusive(intent,attempt,"Direkter YouTube-Link vorhanden, aber kein deterministischer Titel-Resolver ist verdrahtet.");

    const probePath=resolve(this.configDir,"session-probes.json"),profilePath=resolve(this.configDir,"profile-verification.json");
    if(!existsSync(probePath)||!existsSync(profilePath))throw new Error("Direct YouTube verification requires calibrated session and profile config");
    const probeEntry=calibratedSessionProbeFor(loadSessionProbeConfigFile(probePath),intent.accountId,"youtube");
    const profileEntry=calibratedProfileVerificationSpecFor(loadProfileVerificationSpecFile(profilePath),intent.accountId,"youtube");
    if(!probeEntry||!profileEntry?.spec.captionMatch)return[];

    const identityRecord=this.store.listBrowserIdentities().find(item=>item.identity.accountId===intent.accountId&&item.identity.enabled);
    if(!identityRecord)throw new Error(`No enabled YouTube browser identity for ${intent.accountId}`);
    const identity=identityRecord.identity;
    if(identity.identityId!==attempt.browserIdentityId)throw new Error("Direct YouTube verification identity differs from publish attempt identity");

    const lock=this.locks.acquire(identity,this.ownerId,this.now());
    let session:Awaited<ReturnType<BrowserRuntimePort["launch"]>>|undefined;
    try{
      session=await this.browser.launch(identity,{headless:this.headless,initialUrl:profileEntry.spec.bootstrapUrl});
      await new BrowserSessionHealthService(this.store,new ConfiguredDomSessionProbe(probeEntry.config)).check(identity.identityId,session,this.now(),{type:"worker",id:this.ownerId});
      new AccountIdentityGuard(this.store).assertReady(identity.identityId);

      const publicUrl=`https://www.youtube.com/watch?v=${encodeURIComponent(hint.videoId)}`;
      await session.navigate(publicUrl);
      const selectors=JSON.stringify(profileEntry.spec.captionMatch.captionSelectors);
      const deadline=Date.now()+10_000;
      let observed:{title:string;ownerHrefs:string[]}={title:"",ownerHrefs:[]};
      while(Date.now()<deadline){
        observed=await session.evaluate<{title:string;ownerHrefs:string[]}>(`(()=>{const normalize=v=>String(v??'').replace(/\\s+/g,' ').trim();let title='';for(const selector of ${selectors}){let el=null;try{el=document.querySelector(selector);}catch{}if(!el)continue;const value=normalize(el.getAttribute&&el.getAttribute('content')||el.textContent||'');if(value){title=value;break;}}const ownerHrefs=Array.from(document.querySelectorAll('a[href]')).map(a=>a.getAttribute('href')||'').filter(h=>h.includes('/@')).slice(0,100);return{title,ownerHrefs};})()`).catch(()=>({title:"",ownerHrefs:[]}));
        if(observed.title&&observed.ownerHrefs.length>0)break;
        await new Promise(resolvePoll=>setTimeout(resolvePoll,400));
      }
      const expected=await this.expectedCopy.expected(intent,attempt);
      const expectedTitle=collapsePostedText(expected.title??"");
      const actualTitle=collapsePostedText(observed.title);
      const expectedHandle=normalizeSocialHandle(identity.expectedHandle);
      const observedHandles=new Set(observed.ownerHrefs.map(ownerHandleFromHref).filter((value):value is string=>Boolean(value)));
      const observedAt=this.now();
      const refs=await this.artifacts.capture(session,intent,identity,attempt,"youtube-direct-verification",observedAt);
      if(expectedTitle&&actualTitle===expectedTitle&&observedHandles.has(expectedHandle)){
        return[{evidenceId:evidenceId(intent.intentId,attempt.attemptId,observedAt),intentId:intent.intentId,attemptId:attempt.attemptId,kind:"profile_permalink",observedAt,positive:true,locator:publicUrl,...(refs[0]?{artifactRef:refs[0]}:{}),note:`Direkte YouTube-Video-ID ${hint.videoId} aus dem Post-Action-Receipt wurde in einer neuen, exakt identifizierten Session geöffnet; Titel und Owner @${expectedHandle} stimmen überein.`}];
      }
      return this.inconclusive(intent,attempt,`Direkte YouTube-Video-ID ${hint.videoId} konnte nicht eindeutig bestätigt werden: title=${actualTitle===expectedTitle?"match":"mismatch"}, owner=${observedHandles.has(expectedHandle)?"match":"missing"}.`,refs[0]);
    }finally{
      if(session)await session.close().catch(()=>{});
      lock.release();
    }
  }

  private inconclusive(intent:PublicationIntent,attempt:PublishAttempt,note:string,artifactRef?:string):readonly VerificationEvidence[]{
    const observedAt=this.now();
    return[{evidenceId:evidenceId(intent.intentId,attempt.attemptId,observedAt),intentId:intent.intentId,attemptId:attempt.attemptId,kind:"inconclusive_profile_check",observedAt,positive:false,...(artifactRef?{artifactRef}:{}),note}];
  }
}
