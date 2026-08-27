import type { DistributionPostingContext } from "../domain/distribution-publish-ports.js";
import type { PlatformExecutionAction, PlatformExecutionPlan } from "../domain/platform-execution.js";
import type { PlatformSurfaceContract, SurfaceContractStep } from "../domain/platform-surface.js";

function locators(step:SurfaceContractStep){return[step.locator,...step.fallbackLocators];}
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
  if(step.stepKey==="COMMENTS")return{stepKey:step.stepKey,operation:"ENSURE_BOOLEAN",locators:locators(step),settingKey:"commentsEnabled",expectedValue:p.commentsEnabled};
  if(step.stepKey==="DUET"){if(p.platform!=="tiktok")throw new Error("Duet step requires TikTok profile");return{stepKey:step.stepKey,operation:"ENSURE_BOOLEAN",locators:locators(step),settingKey:"duetEnabled",expectedValue:p.duetEnabled};}
  if(step.stepKey==="STITCH"){if(p.platform!=="tiktok")throw new Error("Stitch step requires TikTok profile");return{stepKey:step.stepKey,operation:"ENSURE_BOOLEAN",locators:locators(step),settingKey:"stitchEnabled",expectedValue:p.stitchEnabled};}
  if(step.stepKey==="SHARE_TO_FEED"){if(p.platform!=="instagram")throw new Error("Share-to-feed step requires Instagram profile");return{stepKey:step.stepKey,operation:"ENSURE_BOOLEAN",locators:locators(step),settingKey:"shareToFeed",expectedValue:p.shareToFeed};}
  if(step.stepKey==="CROSSPOST_FACEBOOK"){if(p.platform!=="instagram")throw new Error("Facebook crosspost step requires Instagram profile");return{stepKey:step.stepKey,operation:"ENSURE_BOOLEAN",locators:locators(step),settingKey:"crosspostFacebook",expectedValue:p.crosspostFacebook};}
  if(step.stepKey==="TRIAL_MODE")return{stepKey:step.stepKey,operation:"ENSURE_BOOLEAN",locators:locators(step),settingKey:"trialMode",expectedValue:true};
  return{stepKey:step.stepKey,operation:"CLICK",locators:locators(step)};
}

export function buildPlatformExecutionPlan(context:DistributionPostingContext,contract:PlatformSurfaceContract):PlatformExecutionPlan{
  if(contract.status!=="CALIBRATED")throw new Error(`Surface contract ${contract.contractId} is not calibrated`);
  if(contract.accountId!==context.intent.accountId)throw new Error("Surface contract belongs to a different account");
  if(contract.postingProfileId!==context.postingProfile.postingProfileId)throw new Error("Surface contract belongs to a different posting profile");
  if(contract.platform!==context.intent.platform||contract.format!==context.intent.format)throw new Error("Surface contract platform/format differs from intent");
  const actions=contract.steps.map(step=>actionFor(step,context));
  if(actions.at(-1)?.operation!=="FINAL_BOUNDARY")throw new Error("Surface contract must terminate at FINAL_BOUNDARY");
  if(actions.slice(0,-1).some(item=>item.operation==="FINAL_BOUNDARY"))throw new Error("FINAL_BOUNDARY may appear only once at the end");
  return{intent:context.intent,provenance:context.provenance,postingProfile:context.postingProfile,surfaceContractId:contract.contractId,environmentFingerprint:contract.environment.fingerprint,actions};
}
