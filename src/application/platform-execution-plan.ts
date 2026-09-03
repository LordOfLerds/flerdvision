import type { PostingProfile } from "../domain/distribution.js";
import type { DistributionPostingContext } from "../domain/distribution-publish-ports.js";
import type { PlatformExecutionAction, PlatformExecutionPlan } from "../domain/platform-execution.js";
import type { PlatformSurfaceContract, SurfaceContractStep } from "../domain/platform-surface.js";

function locators(step:SurfaceContractStep){return[step.locator,...step.fallbackLocators];}
function booleanExpected(step:SurfaceContractStep,desired:boolean):boolean{return step.booleanPolarity==="INVERTED"?!desired:desired;}
/** Operator provenance: only settings written in the canonical spec are enforceable. */
function demanded(profile: PostingProfile, key: string): boolean {
  return profile.explicitSettings === undefined || profile.explicitSettings.includes(key);
}
function actionFor(step:SurfaceContractStep,context:DistributionPostingContext):PlatformExecutionAction{
  const p=context.postingProfile;
  if(step.stepKey==="UPLOAD_MEDIA")return{stepKey:step.stepKey,operation:"SET_MEDIA",locators:locators(step)};
  if(step.stepKey==="CAPTION")return{stepKey:step.stepKey,operation:"FILL_CAPTION",locators:locators(step)};
  if(step.stepKey==="TITLE")return{stepKey:step.stepKey,operation:"FILL_TITLE",locators:locators(step)};
  if(step.stepKey==="FINAL_ACTION")return{stepKey:step.stepKey,operation:"FINAL_BOUNDARY",locators:locators(step)};
  if(step.stepKey==="VISIBILITY"){
    if(p.platform!=="tiktok"&&p.platform!=="youtube")throw new Error("Visibility step is not valid for this posting profile");
    return{stepKey:step.stepKey,operation:"SELECT_ENUM",locators:locators(step),settingKey:"visibility",expectedValue:p.visibility};
  }
  if(step.stepKey==="AUDIENCE"){
    if(p.platform!=="youtube")throw new Error("Audience step requires a YouTube profile");
    if(p.madeForKids===undefined)throw new Error("Audience step requires settings.madeForKids in the canonical spec");
    return{stepKey:step.stepKey,operation:"ANSWER_AUDIENCE",locators:locators(step),settingKey:"madeForKids",expectedValue:p.madeForKids};
  }
  if(step.stepKey==="COMMENTS")return{stepKey:step.stepKey,operation:"ENSURE_BOOLEAN",locators:locators(step),settingKey:"commentsEnabled",expectedValue:booleanExpected(step,p.commentsEnabled),operatorDemanded:demanded(p,"commentsEnabled")};
  if(step.stepKey==="DUET"){if(p.platform!=="tiktok")throw new Error("Duet step requires TikTok profile");return{stepKey:step.stepKey,operation:"ENSURE_BOOLEAN",locators:locators(step),settingKey:"duetEnabled",expectedValue:booleanExpected(step,p.duetEnabled),operatorDemanded:demanded(p,"duetEnabled")};}
  if(step.stepKey==="STITCH"){if(p.platform!=="tiktok")throw new Error("Stitch step requires TikTok profile");return{stepKey:step.stepKey,operation:"ENSURE_BOOLEAN",locators:locators(step),settingKey:"stitchEnabled",expectedValue:booleanExpected(step,p.stitchEnabled),operatorDemanded:demanded(p,"stitchEnabled")};}
  if(step.stepKey==="SHARE_TO_FEED"){if(p.platform!=="instagram")throw new Error("Share-to-feed step requires Instagram profile");return{stepKey:step.stepKey,operation:"ENSURE_BOOLEAN",locators:locators(step),settingKey:"shareToFeed",expectedValue:booleanExpected(step,p.shareToFeed),operatorDemanded:demanded(p,"shareToFeed")};}
  if(step.stepKey==="CROSSPOST_FACEBOOK"){if(p.platform!=="instagram")throw new Error("Facebook crosspost step requires Instagram profile");return{stepKey:step.stepKey,operation:"ENSURE_BOOLEAN",locators:locators(step),settingKey:"crosspostFacebook",expectedValue:booleanExpected(step,p.crosspostFacebook),operatorDemanded:demanded(p,"crosspostFacebook")};}
  if(step.stepKey==="TRIAL_MODE")return{stepKey:step.stepKey,operation:"ENSURE_BOOLEAN",locators:locators(step),settingKey:"trialMode",expectedValue:booleanExpected(step,true)};
  return{stepKey:step.stepKey,operation:"CLICK",locators:locators(step)};
}

function assertContractMatches(context:DistributionPostingContext,contract:PlatformSurfaceContract):void{
  if(contract.accountId!==context.intent.accountId)throw new Error("Surface contract belongs to a different account");
  if(contract.postingProfileId!==context.postingProfile.postingProfileId)throw new Error("Surface contract belongs to a different posting profile");
  if(contract.platform!==context.intent.platform||contract.format!==context.intent.format)throw new Error("Surface contract platform/format differs from intent");
}
function planFromContract(context:DistributionPostingContext,contract:PlatformSurfaceContract):PlatformExecutionPlan{
  assertContractMatches(context,contract);
  const actions=contract.steps.map(step=>actionFor(step,context));
  if(actions.at(-1)?.operation!=="FINAL_BOUNDARY")throw new Error("Surface contract must terminate at FINAL_BOUNDARY");
  if(actions.slice(0,-1).some(item=>item.operation==="FINAL_BOUNDARY"))throw new Error("FINAL_BOUNDARY may appear only once at the end");
  return{intent:context.intent,provenance:context.provenance,postingProfile:context.postingProfile,surfaceContractId:contract.contractId,environmentFingerprint:contract.environment.fingerprint,environment:contract.environment,actions};
}

/** Production/runtime execution accepts only a fully qualified surface contract. */
export function buildPlatformExecutionPlan(context:DistributionPostingContext,contract:PlatformSurfaceContract):PlatformExecutionPlan{
  if(contract.status!=="CALIBRATED")throw new Error(`Surface contract ${contract.contractId} is not calibrated`);
  return planFromContract(context,contract);
}

/**
 * Calibration replay is the sole exception that may execute a RECORDED contract.
 * The resulting plan still terminates at FINAL_BOUNDARY and must be run by a no-final-action executor.
 * Successful replays become evidence for PlatformSurfaceRegistryService.qualify; they never authorize publish.
 */
export function buildCalibrationReplayPlan(context:DistributionPostingContext,contract:PlatformSurfaceContract):PlatformExecutionPlan{
  if(contract.status!=="RECORDED"&&contract.status!=="CALIBRATED")throw new Error(`Unsupported surface contract status: ${contract.status}`);
  return planFromContract(context,contract);
}
