import type { PostingProfile } from "./distribution.js";
import type { Platform, PublicationFormat } from "./model.js";
import type { UiLocator } from "./platform-ui.js";

export type CalibrationActionMode = "OBSERVE_ACTION" | "BLOCK_ACTION";
export interface SurfaceEnvironment { browserFamily:"chromium"; browserMajor:number; language:string; timeZone:string; viewportWidth:number; viewportHeight:number; deviceScaleFactor:number; fingerprint:string; }
export interface SurfaceLocatorCandidate { locator:UiLocator; confidence:"HIGH"|"MEDIUM"|"LOW"; reason:string; }
export interface SurfaceStepDefinition { stepKey:string; label:string; actionMode:CalibrationActionMode; required:boolean; }
export interface SurfaceStepObservation { observationId:string; accountId:string; platform:Platform; format:PublicationFormat; stepKey:string; observedAt:string; environment:SurfaceEnvironment; currentUrl:string; tagName:string; candidates:readonly SurfaceLocatorCandidate[]; actionBlocked:boolean; }
export interface SurfaceContractStep { stepKey:string; label:string; actionMode:CalibrationActionMode; locator:UiLocator; fallbackLocators:readonly UiLocator[]; observations:number; }
export type PlatformSurfaceContractStatus = "RECORDED" | "CALIBRATED";
export interface PlatformSurfaceContract { contractId:string; accountId:string; platform:Platform; format:PublicationFormat; postingProfileId:string; environment:SurfaceEnvironment; steps:readonly SurfaceContractStep[]; status:PlatformSurfaceContractStatus; createdAt:string; calibratedAt?:string; }
export interface SurfaceReplayEvidence { replayId:string; contractId:string; checkedAt:string; passed:boolean; reachedFinalActionBoundary:boolean; finalActionInvoked:boolean; environmentFingerprint:string; artifactRefs:readonly string[]; }
export interface SurfaceRecipe { platform:Platform; format:PublicationFormat; postingProfileId:string; steps:readonly SurfaceStepDefinition[]; }

export function surfaceRecipeForPostingProfile(profile:PostingProfile):SurfaceRecipe {
  const final:SurfaceStepDefinition={stepKey:"FINAL_ACTION",label:"Final publish/share boundary",actionMode:"BLOCK_ACTION",required:true};
  if(profile.platform==="instagram"){
    if(profile.format==="story")return{platform:"instagram",format:"story",postingProfileId:profile.postingProfileId,steps:[{stepKey:"OPEN_CREATE",label:"Open create flow",actionMode:"OBSERVE_ACTION",required:true},{stepKey:"SELECT_STORY",label:"Select Story format",actionMode:"OBSERVE_ACTION",required:true},{stepKey:"UPLOAD_MEDIA",label:"Upload Story media",actionMode:"OBSERVE_ACTION",required:true},final]};
    const steps:SurfaceStepDefinition[]=[{stepKey:"OPEN_CREATE",label:"Open create flow",actionMode:"OBSERVE_ACTION",required:true},{stepKey:"SELECT_REEL",label:"Select Reel format",actionMode:"OBSERVE_ACTION",required:true},{stepKey:"UPLOAD_MEDIA",label:"Upload Reel media",actionMode:"OBSERVE_ACTION",required:true},{stepKey:"NEXT_AFTER_UPLOAD",label:"Continue after upload",actionMode:"OBSERVE_ACTION",required:true},{stepKey:"NEXT_TO_DETAILS",label:"Continue to details",actionMode:"OBSERVE_ACTION",required:true},{stepKey:"CAPTION",label:"Caption field",actionMode:"OBSERVE_ACTION",required:true}];
    if(profile.format==="trial_reel")steps.push({stepKey:"TRIAL_MODE",label:"Trial Reel mode",actionMode:"OBSERVE_ACTION",required:true});
    steps.push({stepKey:"SHARE_TO_FEED",label:"Share to feed setting",actionMode:"OBSERVE_ACTION",required:true},{stepKey:"CROSSPOST_FACEBOOK",label:"Facebook cross-post setting",actionMode:"OBSERVE_ACTION",required:true},{stepKey:"COMMENTS",label:"Comments setting",actionMode:"OBSERVE_ACTION",required:true},final);
    return{platform:"instagram",format:profile.format,postingProfileId:profile.postingProfileId,steps};
  }
  if(profile.platform==="tiktok")return{platform:"tiktok",format:"tiktok",postingProfileId:profile.postingProfileId,steps:[{stepKey:"OPEN_UPLOAD",label:"Open upload flow",actionMode:"OBSERVE_ACTION",required:true},{stepKey:"UPLOAD_MEDIA",label:"Upload video",actionMode:"OBSERVE_ACTION",required:true},{stepKey:"CAPTION",label:"Caption field",actionMode:"OBSERVE_ACTION",required:true},{stepKey:"VISIBILITY",label:"Who can view this post",actionMode:"OBSERVE_ACTION",required:true},{stepKey:"COMMENTS",label:"Comments setting",actionMode:"OBSERVE_ACTION",required:true},{stepKey:"DUET",label:"Duet setting",actionMode:"OBSERVE_ACTION",required:true},{stepKey:"STITCH",label:"Stitch setting",actionMode:"OBSERVE_ACTION",required:true},final]};
  return{platform:"youtube",format:"short",postingProfileId:profile.postingProfileId,steps:[{stepKey:"OPEN_UPLOAD",label:"Open upload flow",actionMode:"OBSERVE_ACTION",required:true},{stepKey:"UPLOAD_MEDIA",label:"Upload Short",actionMode:"OBSERVE_ACTION",required:true},{stepKey:"TITLE",label:"Title field",actionMode:"OBSERVE_ACTION",required:true},{stepKey:"VISIBILITY",label:"Visibility setting",actionMode:"OBSERVE_ACTION",required:true},final]};
}
