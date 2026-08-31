import type { PostingProfile } from "./distribution.js";
import type { DistributionIntentProvenance } from "./distribution-provenance.js";
import type { PublicationIntent } from "./model.js";
import type { UiLocator } from "./platform-ui.js";
import type { SurfaceEnvironment } from "./platform-surface.js";

export type PlatformExecutionOperation = "CLICK" | "SET_MEDIA" | "FILL_CAPTION" | "FILL_TITLE" | "ENSURE_BOOLEAN" | "SELECT_ENUM" | "FINAL_BOUNDARY";
export interface PlatformExecutionAction { stepKey:string; operation:PlatformExecutionOperation; locators:readonly UiLocator[]; settingKey?:"visibility"|"commentsEnabled"|"duetEnabled"|"stitchEnabled"|"shareToFeed"|"crosspostFacebook"|"trialMode"; expectedValue?:string|boolean; /** True when the setting was never demanded by the operator: the platform default stands and an unprovable control is not a failure. */ operatorDemanded?:boolean; }
export interface PlatformExecutionPlan { intent:PublicationIntent; provenance:DistributionIntentProvenance; postingProfile:PostingProfile; surfaceContractId:string; environmentFingerprint:string; environment?:SurfaceEnvironment; actions:readonly PlatformExecutionAction[]; }
