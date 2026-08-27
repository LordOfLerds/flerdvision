import type { PostingProfile } from "./distribution.js";
import type { DistributionIntentProvenance } from "./distribution-provenance.js";
import type { PublicationIntent } from "./model.js";
import type { UiLocator } from "./platform-ui.js";

export type PlatformExecutionOperation = "CLICK" | "SET_MEDIA" | "FILL_CAPTION" | "FILL_TITLE" | "ENSURE_BOOLEAN" | "SELECT_ENUM" | "FINAL_BOUNDARY";
export interface PlatformExecutionAction { stepKey:string; operation:PlatformExecutionOperation; locators:readonly UiLocator[]; settingKey?:"visibility"|"commentsEnabled"|"duetEnabled"|"stitchEnabled"|"shareToFeed"|"crosspostFacebook"|"trialMode"; expectedValue?:string|boolean; }
export interface PlatformExecutionPlan { intent:PublicationIntent; provenance:DistributionIntentProvenance; postingProfile:PostingProfile; surfaceContractId:string; environmentFingerprint:string; actions:readonly PlatformExecutionAction[]; }
