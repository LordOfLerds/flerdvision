import test from "node:test";
import assert from "node:assert/strict";
import { PRIVATE_E2E_VARIANTS, assertSecretLiveVariant, campaignVariant, requiredCampaignCoverage } from "../dist/domain/e2e-campaign.js";
import { CurrentCreatorWeekDayPathInterpreter } from "../dist/adapters/ingress/interpreters.js";

test("W8 campaign covers normal/trial Instagram and all TikTok audience variants", () => {
  const ids = new Set(PRIVATE_E2E_VARIANTS.map((item) => item.variantId));
  for (const id of [
    "instagram.normal_reel.private_zero_followers",
    "instagram.trial_reel.nonfollowers",
    "tiktok.video.only_you",
    "tiktok.video.followers",
    "tiktok.video.friends",
    "tiktok.video.everyone"
  ]) assert.equal(ids.has(id), true, `missing ${id}`);
  const coverage = requiredCampaignCoverage();
  assert.equal(coverage.instagram.length, 2);
  assert.equal(coverage.tiktok.length, 4);
});

test("zero-viewer live eligibility is limited to normal private Instagram Reel and TikTok Only you", () => {
  assert.doesNotThrow(() => assertSecretLiveVariant(campaignVariant("instagram.normal_reel.private_zero_followers")));
  assert.doesNotThrow(() => assertSecretLiveVariant(campaignVariant("tiktok.video.only_you")));
  for (const id of [
    "instagram.trial_reel.nonfollowers",
    "tiktok.video.followers",
    "tiktok.video.friends",
    "tiktok.video.everyone"
  ]) assert.throws(() => assertSecretLiveVariant(campaignVariant(id)), /not eligible/);
});

test("demo Drive current-schema lanes stay interpreter configuration, not domain logic", async () => {
  const interpreter = new CurrentCreatorWeekDayPathInterpreter({
    creatorAliases: { "01_TestCreator": "creator_e2e_test" },
    weekStartBySegment: { "2026-KW35": "2026-08-24" },
    formatFolderHints: {
      "01_instagram_normal_reel_secret": ["reel", "e2e:instagram.normal_reel.private_zero_followers"],
      "02_instagram_trial_reel_prepare_only": ["trial_reel", "e2e:instagram.trial_reel.nonfollowers"],
      "03_tiktok_onlyyou_secret": ["tiktok", "audience:only_you", "e2e:tiktok.video.only_you"]
    }
  });
  const base = { sourceId: "demo", observedAt: "2026-08-26T18:00:00Z", mediaFingerprint: "sha:test", locator: "drive://file" };
  const ig = await interpreter.interpret({ ...base, observationId: "obs:ig", externalObjectId: "ig", metadata: { relativePath: "01_TestCreator/2026-KW35/03_Mittwoch/01_Instagram_Normal_Reel_SECRET/test.mp4" } });
  assert.equal(ig.decision, "accept");
  assert.equal(ig.creatorId, "creator_e2e_test");
  assert.equal(ig.scheduledBusinessDate, "2026-08-26");
  assert.deepEqual(ig.formatHints, ["e2e:instagram.normal_reel.private_zero_followers", "reel"]);
  const tt = await interpreter.interpret({ ...base, observationId: "obs:tt", externalObjectId: "tt", metadata: { relativePath: "01_TestCreator/2026-KW35/03_Mittwoch/03_TikTok_OnlyYou_SECRET/test.mp4" } });
  assert.deepEqual(tt.formatHints, ["audience:only_you", "e2e:tiktok.video.only_you", "tiktok"]);
});
