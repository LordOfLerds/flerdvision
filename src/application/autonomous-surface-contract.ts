import { createHash } from "node:crypto";
import type { PostingProfile } from "../domain/distribution.js";
import type { PlatformSurfaceContract, SurfaceContractStep } from "../domain/platform-surface.js";

const SETTING_KEYS = new Set(["TRIAL_MODE", "SHARE_TO_FEED", "CROSSPOST_FACEBOOK", "COMMENTS", "VISIBILITY", "DUET", "STITCH"]);

/** Maps a contract step to the spec settings key whose provenance decides whether it may be absent. */
const SETTING_SPEC_KEYS: Readonly<Record<string, string>> = {
  SHARE_TO_FEED: "shareToFeed",
  CROSSPOST_FACEBOOK: "crosspostFacebook",
  COMMENTS: "commentsEnabled",
  DUET: "duetEnabled",
  STITCH: "stitchEnabled",
  VISIBILITY: "visibility"
};

function platformSettingOrder(profile: PostingProfile): readonly string[] {
    if (profile.platform === "instagram") {
      if (profile.format === "story") return [];
      return profile.format === "trial_reel"
        ? ["TRIAL_MODE", "SHARE_TO_FEED", "CROSSPOST_FACEBOOK", "COMMENTS"]
        : ["SHARE_TO_FEED", "CROSSPOST_FACEBOOK", "COMMENTS"];
    }
  if (profile.platform === "tiktok") return ["VISIBILITY", "COMMENTS", "DUET", "STITCH"];
  return ["VISIBILITY"];
}

function requiredSettings(profile: PostingProfile): readonly string[] {
  const all = platformSettingOrder(profile);
  // The exploration phase records a control only when the surface offers it, and it may skip an
  // absent control only for settings the operator never wrote (compiler defaults). The contract
  // validator must judge by the same provenance rule, or it re-imposes the invented requirement
  // one layer downstream -- which is exactly how the missing share-to-feed toggle failed a run
  // AFTER the settings phase had already skipped it correctly. Profiles without provenance
  // (compiled before explicitSettings existed) stay fully strict. TRIAL_MODE is not an operator
  // setting but the format itself, so it is always required.
  if (profile.explicitSettings === undefined) return all;
  const explicit = new Set(profile.explicitSettings);
  return all.filter((stepKey) => {
    const specKey = SETTING_SPEC_KEYS[stepKey];
    return specKey === undefined || explicit.has(specKey);
  });
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
  // Presence in the contract and being required are different questions: a control the surface
  // offered gets recorded and replayed even when the operator never demanded it; only the
  // missing-check above is provenance-filtered. Order stays the canonical platform order.
  const orderedSettings = platformSettingOrder(profile)
    .map((stepKey) => byStep.get(stepKey))
    .filter((step): step is SurfaceContractStep => step !== undefined);
  const steps = [...base, ...(advanced ? [advanced] : []), ...orderedSettings, final];
  const contractId = `surface:${createHash("sha256").update(`${contract.accountId}|${contract.postingProfileId}|${contract.environment.fingerprint}|${steps.map(key).join("|")}`).digest("hex").slice(0, 24)}`;
  const { calibratedAt: _stale, ...recorded } = contract;
  return { ...recorded, contractId, steps, status: "RECORDED" };
}
