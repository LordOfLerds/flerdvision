import { readFileSync } from "node:fs";
import type { Platform } from "../../domain/model.js";
import type { UiLocator } from "../../domain/platform-ui.js";
import type { ProfileCaptionMatchSpec, ProfileVerificationSpec } from "./profile.js";

export interface ProfileVerificationSpecEntry {
  specId:string;
  platform:Platform;
  accountId?:string;
  calibrationStatus:"UNVERIFIED"|"CALIBRATED";
  calibratedAt?:string;
  calibratedBy?:string;
  spec:ProfileVerificationSpec;
}
export interface ProfileVerificationSpecFile {schemaVersion:1;specs:readonly ProfileVerificationSpecEntry[];}
export class ProfileVerificationSpecConfigError extends Error {}

function locator(value:unknown,path:string,allowPlaceholder:boolean):UiLocator{
  if(!value||typeof value!=="object")throw new ProfileVerificationSpecConfigError(`${path} must be an object`);
  const item=value as Record<string,unknown>;
  if(item.kind!=="css"&&item.kind!=="text"&&item.kind!=="role"&&item.kind!=="label")throw new ProfileVerificationSpecConfigError(`${path}.kind is invalid`);
  if(typeof item.value!=="string"||!item.value.trim())throw new ProfileVerificationSpecConfigError(`${path}.value is required`);
  if(!allowPlaceholder&&item.value.includes("__CALIBRATE__"))throw new ProfileVerificationSpecConfigError(`${path} still contains calibration placeholder`);
  return{kind:item.kind,value:item.value,...(typeof item.exact==="boolean"?{exact:item.exact}:{}),...(typeof item.role==="string"?{role:item.role}:{})};
}
function locators(value:unknown,path:string,allowPlaceholder:boolean):readonly UiLocator[]{
  if(!Array.isArray(value)||value.length===0)throw new ProfileVerificationSpecConfigError(`${path} must be a non-empty array`);
  return value.map((item,index)=>locator(item,`${path}[${index}]`,allowPlaceholder));
}
function selector(value:unknown,path:string,allowPlaceholder:boolean):string{
  if(typeof value!=="string"||!value.trim())throw new ProfileVerificationSpecConfigError(`${path} must be a non-empty selector`);
  if(!allowPlaceholder&&value.includes("__CALIBRATE__"))throw new ProfileVerificationSpecConfigError(`${path} still contains calibration placeholder`);
  return value;
}
function parseCaptionMatch(value:unknown,path:string,allowPlaceholder:boolean):ProfileCaptionMatchSpec{
  if(!value||typeof value!=="object")throw new ProfileVerificationSpecConfigError(`${path} must be an object`);
  const item=value as Record<string,unknown>;
  if(!Array.isArray(item.captionSelectors)||item.captionSelectors.length===0)throw new ProfileVerificationSpecConfigError(`${path}.captionSelectors must be a non-empty array`);
  const captionSelectors=item.captionSelectors.map((entry,index)=>selector(entry,`${path}.captionSelectors[${index}]`,allowPlaceholder));
  // Without a readable publish time the window cannot be applied, and a post outside the window
  // must never be matched -- so the timestamp read is part of the contract, not an option.
  const timestampSelector=selector(item.timestampSelector,`${path}.timestampSelector`,allowPlaceholder);
  if(item.timestampAttribute!==undefined&&(typeof item.timestampAttribute!=="string"||!item.timestampAttribute.trim()))throw new ProfileVerificationSpecConfigError(`${path}.timestampAttribute must be non-empty`);
  if(item.durationSelector!==undefined&&(typeof item.durationSelector!=="string"||!item.durationSelector.trim()))throw new ProfileVerificationSpecConfigError(`${path}.durationSelector must be non-empty`);
  if(item.durationAttribute!==undefined&&(typeof item.durationAttribute!=="string"||!item.durationAttribute.trim()))throw new ProfileVerificationSpecConfigError(`${path}.durationAttribute must be non-empty`);
  if(item.windowLeadSeconds!==undefined&&(!Number.isInteger(item.windowLeadSeconds)||(item.windowLeadSeconds as number)<0||(item.windowLeadSeconds as number)>3600))throw new ProfileVerificationSpecConfigError(`${path}.windowLeadSeconds must be an integer between 0 and 3600`);
  return{
    captionSelectors,timestampSelector,
    ...(typeof item.timestampAttribute==="string"?{timestampAttribute:item.timestampAttribute}:{}),
    ...(typeof item.durationSelector==="string"?{durationSelector:item.durationSelector}:{}),
    ...(typeof item.durationAttribute==="string"?{durationAttribute:item.durationAttribute}:{}),
    ...(typeof item.windowLeadSeconds==="number"?{windowLeadSeconds:item.windowLeadSeconds}:{})
  };
}
function parseSpec(value:unknown,path:string,allowPlaceholder:boolean):ProfileVerificationSpec{
  if(!value||typeof value!=="object")throw new ProfileVerificationSpecConfigError(`${path} must be an object`);
  const item=value as Record<string,unknown>;
  if(item.platform!=="instagram"&&item.platform!=="tiktok"&&item.platform!=="youtube")throw new ProfileVerificationSpecConfigError(`${path}.platform is invalid`);
  if(typeof item.bootstrapUrl!=="string"||!/^https:\/\//.test(item.bootstrapUrl))throw new ProfileVerificationSpecConfigError(`${path}.bootstrapUrl must be https`);
  if(typeof item.profileUrlTemplate!=="string"||!/^https:\/\//.test(item.profileUrlTemplate))throw new ProfileVerificationSpecConfigError(`${path}.profileUrlTemplate must be https`);
  if(!allowPlaceholder&&(item.profileUrlTemplate.includes("__CALIBRATE__")))throw new ProfileVerificationSpecConfigError(`${path}.profileUrlTemplate still contains calibration placeholder`);
  if(item.permalinkAttribute!==undefined&&(typeof item.permalinkAttribute!=="string"||!item.permalinkAttribute.trim()))throw new ProfileVerificationSpecConfigError(`${path}.permalinkAttribute must be non-empty`);
  // Deep post-page verification (reels tab): the whitelist rebuild below silently dropped these
  // on the calibration round-trip once already -- unknown-field stripping is right, forgetting
  // to whitelist new contract fields is not.
  if(item.postListUrlTemplate!==undefined&&(typeof item.postListUrlTemplate!=="string"||!/^https:\/\//.test(item.postListUrlTemplate)))throw new ProfileVerificationSpecConfigError(`${path}.postListUrlTemplate must be https`);
  if(item.postLinkSelector!==undefined&&(typeof item.postLinkSelector!=="string"||!item.postLinkSelector.trim()))throw new ProfileVerificationSpecConfigError(`${path}.postLinkSelector must be non-empty`);
  if((item.postListUrlTemplate===undefined)!==(item.postLinkSelector===undefined))throw new ProfileVerificationSpecConfigError(`${path} must set postListUrlTemplate and postLinkSelector together`);
  if(item.postOpenLimit!==undefined&&(!Number.isInteger(item.postOpenLimit)||(item.postOpenLimit as number)<1||(item.postOpenLimit as number)>10))throw new ProfileVerificationSpecConfigError(`${path}.postOpenLimit must be an integer between 1 and 10`);
  const captionMatch=item.captionMatch===undefined?undefined:parseCaptionMatch(item.captionMatch,`${path}.captionMatch`,allowPlaceholder);
  // Exactly one matching rule per spec: a marker text locator, or marker-free caption equality.
  // Both at once would leave it unclear which one a VERIFIED came from.
  if(captionMatch===undefined&&item.postMatchLocators===undefined)throw new ProfileVerificationSpecConfigError(`${path} must set postMatchLocators or captionMatch`);
  if(captionMatch!==undefined&&item.postMatchLocators!==undefined)throw new ProfileVerificationSpecConfigError(`${path} must not set postMatchLocators together with captionMatch`);
  // The caption renders on the post page, never on the grid, so marker-free matching cannot work
  // without a list to walk.
  if(captionMatch!==undefined&&(item.postListUrlTemplate===undefined||item.postLinkSelector===undefined))throw new ProfileVerificationSpecConfigError(`${path}.captionMatch requires postListUrlTemplate and postLinkSelector`);
  return{
    platform:item.platform,bootstrapUrl:item.bootstrapUrl,profileUrlTemplate:item.profileUrlTemplate,
    profileReadyLocators:locators(item.profileReadyLocators,`${path}.profileReadyLocators`,allowPlaceholder),
    ...(item.postMatchLocators!==undefined?{postMatchLocators:locators(item.postMatchLocators,`${path}.postMatchLocators`,allowPlaceholder)}:{}),
    ...(captionMatch!==undefined?{captionMatch}:{}),
    ...(typeof item.permalinkAttribute==="string"?{permalinkAttribute:item.permalinkAttribute}:{}),
    ...(typeof item.postListUrlTemplate==="string"?{postListUrlTemplate:item.postListUrlTemplate}:{}),
    ...(typeof item.postLinkSelector==="string"?{postLinkSelector:item.postLinkSelector}:{}),
    ...(typeof item.postOpenLimit==="number"?{postOpenLimit:item.postOpenLimit}:{})
  };
}

export function parseProfileVerificationSpecFile(raw:unknown,requireCalibrated=false):ProfileVerificationSpecFile{
  if(!raw||typeof raw!=="object")throw new ProfileVerificationSpecConfigError("Profile verification config must be an object");
  const file=raw as Record<string,unknown>;
  if(file.schemaVersion!==1)throw new ProfileVerificationSpecConfigError("Unsupported profile verification schemaVersion");
  if(!Array.isArray(file.specs))throw new ProfileVerificationSpecConfigError("Profile verification specs must be an array");
  const ids=new Set<string>();
  const specs=file.specs.map((rawEntry,index):ProfileVerificationSpecEntry=>{
    if(!rawEntry||typeof rawEntry!=="object")throw new ProfileVerificationSpecConfigError(`specs[${index}] must be an object`);
    const entry=rawEntry as Record<string,unknown>;
    if(typeof entry.specId!=="string"||!entry.specId.trim())throw new ProfileVerificationSpecConfigError(`specs[${index}].specId is required`);
    if(ids.has(entry.specId))throw new ProfileVerificationSpecConfigError(`Duplicate specId: ${entry.specId}`);ids.add(entry.specId);
    if(entry.platform!=="instagram"&&entry.platform!=="tiktok"&&entry.platform!=="youtube")throw new ProfileVerificationSpecConfigError(`specs[${index}].platform is invalid`);
    if(entry.accountId!==undefined&&(typeof entry.accountId!=="string"||!entry.accountId.trim()))throw new ProfileVerificationSpecConfigError(`specs[${index}].accountId must be non-empty when provided`);
    if(entry.calibrationStatus!=="UNVERIFIED"&&entry.calibrationStatus!=="CALIBRATED")throw new ProfileVerificationSpecConfigError(`specs[${index}].calibrationStatus is invalid`);
    const calibrated=entry.calibrationStatus==="CALIBRATED";
    if(requireCalibrated&&!calibrated)throw new ProfileVerificationSpecConfigError(`Spec ${entry.specId} is not calibrated`);
    if(calibrated&&(typeof entry.calibratedAt!=="string"||typeof entry.calibratedBy!=="string"))throw new ProfileVerificationSpecConfigError(`Calibrated spec ${entry.specId} requires calibratedAt and calibratedBy`);
    const spec=parseSpec(entry.spec,`specs[${index}].spec`,!calibrated&&!requireCalibrated);
    if(spec.platform!==entry.platform)throw new ProfileVerificationSpecConfigError(`Spec ${entry.specId} platform mismatch`);
    return{specId:entry.specId.trim(),platform:entry.platform,...(typeof entry.accountId==="string"?{accountId:entry.accountId.trim()}:{}),calibrationStatus:entry.calibrationStatus,...(typeof entry.calibratedAt==="string"?{calibratedAt:entry.calibratedAt}:{}),...(typeof entry.calibratedBy==="string"?{calibratedBy:entry.calibratedBy}:{}),spec};
  });
  return{schemaVersion:1,specs};
}

export function loadProfileVerificationSpecFile(path:string):ProfileVerificationSpecFile{return parseProfileVerificationSpecFile(JSON.parse(readFileSync(path,"utf8")) as unknown,false);}
export function calibratedProfileVerificationSpecFor(file:ProfileVerificationSpecFile,accountId:string,platform:Platform):ProfileVerificationSpecEntry|null{
  const exact=file.specs.filter(item=>item.calibrationStatus==="CALIBRATED"&&item.platform===platform&&item.accountId===accountId);
  if(exact.length>1)throw new ProfileVerificationSpecConfigError(`Multiple calibrated verification specs match account ${accountId}`);
  if(exact.length===1)return exact[0]!;
  const generic=file.specs.filter(item=>item.calibrationStatus==="CALIBRATED"&&item.platform===platform&&!item.accountId);
  if(generic.length>1)throw new ProfileVerificationSpecConfigError(`Multiple calibrated generic verification specs match ${platform}`);
  return generic[0]??null;
}
