import type { Platform, PublicationFormat } from "./model.js";

export type E2EAudienceMode =
  | "instagram_private_account"
  | "instagram_trial_nonfollowers"
  | "tiktok_only_you"
  | "tiktok_followers"
  | "tiktok_friends"
  | "tiktok_everyone";

export type E2EExecutionMode = "PREPARE_ONLY" | "LIVE_SECRET" | "LIVE_EXPOSURE_REQUIRES_EXPLICIT_APPROVAL";

export interface E2ECampaignVariant {
  variantId: string;
  platform: Platform;
  format: PublicationFormat;
  audienceMode: E2EAudienceMode;
  executionMode: E2EExecutionMode;
  requiredPrepareOnlyPasses: number;
  secretSafe: boolean;
  note: string;
}

export const PRIVATE_E2E_VARIANTS: readonly E2ECampaignVariant[] = [
  {
    variantId: "instagram.normal_reel.private_zero_followers",
    platform: "instagram",
    format: "reel",
    audienceMode: "instagram_private_account",
    executionMode: "LIVE_SECRET",
    requiredPrepareOnlyPasses: 3,
    secretSafe: true,
    note: "Live only after zero-viewer privacy attestation on the private test account."
  },
  {
    variantId: "instagram.trial_reel.nonfollowers",
    platform: "instagram",
    format: "trial_reel",
    audienceMode: "instagram_trial_nonfollowers",
    executionMode: "LIVE_EXPOSURE_REQUIRES_EXPLICIT_APPROVAL",
    requiredPrepareOnlyPasses: 3,
    secretSafe: false,
    note: "Trial Reels intentionally target non-followers; zero-viewer live testing is impossible by design."
  },
  {
    variantId: "tiktok.video.only_you",
    platform: "tiktok",
    format: "tiktok",
    audienceMode: "tiktok_only_you",
    executionMode: "LIVE_SECRET",
    requiredPrepareOnlyPasses: 3,
    secretSafe: true,
    note: "Use TikTok per-post audience Only you for the first live E2E publish."
  },
  {
    variantId: "tiktok.video.followers",
    platform: "tiktok",
    format: "tiktok",
    audienceMode: "tiktok_followers",
    executionMode: "PREPARE_ONLY",
    requiredPrepareOnlyPasses: 1,
    secretSafe: false,
    note: "Calibrate and prepare only during zero-viewer campaign."
  },
  {
    variantId: "tiktok.video.friends",
    platform: "tiktok",
    format: "tiktok",
    audienceMode: "tiktok_friends",
    executionMode: "PREPARE_ONLY",
    requiredPrepareOnlyPasses: 1,
    secretSafe: false,
    note: "Calibrate and prepare only during zero-viewer campaign."
  },
  {
    variantId: "tiktok.video.everyone",
    platform: "tiktok",
    format: "tiktok",
    audienceMode: "tiktok_everyone",
    executionMode: "PREPARE_ONLY",
    requiredPrepareOnlyPasses: 1,
    secretSafe: false,
    note: "Never use Everyone for a secret private-account E2E run."
  }
] as const;

export function campaignVariant(variantId: string): E2ECampaignVariant {
  const variant = PRIVATE_E2E_VARIANTS.find((item) => item.variantId === variantId);
  if (!variant) throw new Error(`Unknown private E2E campaign variant: ${variantId}`);
  return variant;
}

export function assertSecretLiveVariant(variant: E2ECampaignVariant): void {
  if (!variant.secretSafe || variant.executionMode !== "LIVE_SECRET") {
    throw new Error(`Variant ${variant.variantId} is not eligible for zero-viewer live E2E`);
  }
}

export function requiredCampaignCoverage(): Readonly<Record<Platform, readonly string[]>> {
  const grouped: Record<Platform, string[]> = { instagram: [], tiktok: [], youtube: [] };
  for (const variant of PRIVATE_E2E_VARIANTS) grouped[variant.platform].push(variant.variantId);
  return grouped;
}
