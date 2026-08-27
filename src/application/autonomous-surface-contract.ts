import { createHash } from "node:crypto";
import type { PostingProfile } from "../domain/distribution.js";
import type { PlatformSurfaceContract, SurfaceContractStep } from "../domain/platform-surface.js";

const SETTING_KEYS = new Set(["TRIAL_MODE", "SHARE_TO_FEED", "CROSSPOST_FACEBOOK", "COMMENTS", "VISIBILITY", "DUET", "STITCH"]);

function requiredSettings(profile: PostingProfile): readonly string[] {
  if (profile.platform === "instagram") {
    if (profile.format === "story") return [];
    return profile.format === "trial_reel"
      ? ["TRIAL_MODE", "SHARE_TO_FEED", "CROSSPOST_FACEBOOK", "COMMENTS"]
      : ["SHARE_TO_FEED", "CROSSPOST_FACEBOOK", "COMMENTS"];
  }
  if (profile.platform === "tiktok") return ["VISIBILITY", "COMMENTS", "DUET", "STITCH"];
  return ["VISIBILITY"];
}
function key(step: SurfaceContractStep): string {
  return JSON.stringify([step.stepKey, step.locator.kind, step.locator.role ?? "", step.locator.value, step.locator.exact ?? false, step.booleanPolarity ?? "DIRECT"]);
}

/**
 * Converts an explored contract into a deterministic replay order. Advanced settings must be opened
 * before any controls that live inside it, and the final action remains the sole terminal step.
 */
export function normalizeAutonomousSurfaceContract(contract: PlatformSurfaceContract, profile: PostingProfile): PlatformSurfaceContract {
  if (contract.accountId.length === 0 || contract.postingProfileId !== profile.postingProfileId) throw new Error("Autonomous surface contract does not match the posting profile");
  const byStep = new Map<string, SurfaceContractStep>();
  for (const step of contract.steps) {
    if (byStep.has(step.stepKey)) throw new Error(`Autonomous surface contract contains duplicate step ${step.stepKey}`);
    byStep.set(step.stepKey, step);
  }
  const final = byStep.get("FINAL_ACTION");
  if (!final) throw new Error("Autonomous surface contract has no FINAL_ACTION boundary");
  for (const required of ["UPLOAD_MEDIA", profile.platform === "youtube" ? "TITLE" : profile.format === "story" ? "UPLOAD_MEDIA" : "CAPTION", ...requiredSettings(profile)]) {
    if (!byStep.has(required)) throw new Error(`Autonomous surface contract is missing required step ${required}`);
  }
  const base = contract.steps.filter((step) => step.stepKey !== "FINAL_ACTION" && step.stepKey !== "ADVANCED_SETTINGS" && !SETTING_KEYS.has(step.stepKey));
  const advanced = byStep.get("ADVANCED_SETTINGS");
  const orderedSettings = requiredSettings(profile).map((stepKey) => byStep.get(stepKey)!);
  const steps = [...base, ...(advanced ? [advanced] : []), ...orderedSettings, final];
  const contractId = `surface:${createHash("sha256").update(`${contract.accountId}|${contract.postingProfileId}|${contract.environment.fingerprint}|${steps.map(key).join("|")}`).digest("hex").slice(0, 24)}`;
  return { ...contract, contractId, steps, status: "RECORDED", calibratedAt: undefined };
}
