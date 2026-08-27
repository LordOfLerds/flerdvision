import test from "node:test";
import assert from "node:assert/strict";
import { normalizeAutonomousSurfaceContract } from "../dist/application/autonomous-surface-contract.js";
import { buildCalibrationReplayPlan } from "../dist/application/platform-execution-plan.js";

const locator = (value) => ({ kind: "text", value, exact: true });
const step = (stepKey, value, extras = {}) => ({ stepKey, label: stepKey, actionMode: stepKey === "FINAL_ACTION" ? "BLOCK_ACTION" : "OBSERVE_ACTION", locator: locator(value), fallbackLocators: [], observations: 1, ...extras });

const profile = {
  postingProfileId: "profile:instagram-reel",
  displayName: "Instagram Reel",
  enabled: true,
  platform: "instagram",
  format: "reel",
  commentsEnabled: false,
  shareToFeed: true,
  crosspostFacebook: false
};
const intent = {
  intentId: "intent:headless",
  contentId: "content:headless",
  creatorId: "creator:headless",
  platform: "instagram",
  accountId: "account:instagram:test",
  format: "reel",
  copyVersionId: "copy:v1",
  scheduledFor: "2026-08-27T12:00:00Z",
  idempotencyKey: "idem:headless"
};
const context = {
  intent,
  postingProfile: profile,
  provenance: {
    planId: "plan:headless",
    deliveryId: "delivery:headless",
    routeId: "route:headless",
    laneId: "lane:headless",
    assetId: "asset:headless",
    postingProfileId: profile.postingProfileId,
    copyProfileId: "copy-profile:headless",
    schedulePolicyId: "schedule:headless",
    routeSnapshotFingerprint: "snapshot:headless",
    postingProfileSnapshot: profile
  }
};

test("advanced settings are replayed before controls and final action remains terminal", () => {
  const original = {
    contractId: "surface:incomplete-id",
    accountId: intent.accountId,
    platform: "instagram",
    format: "reel",
    postingProfileId: profile.postingProfileId,
    environment: { browserFamily: "chromium", browserMajor: 140, language: "de-AT", timeZone: "Europe/Vienna", viewportWidth: 1280, viewportHeight: 800, deviceScaleFactor: 1, fingerprint: "environment:v1" },
    steps: [
      step("OPEN_CREATE", "Create"),
      step("UPLOAD_MEDIA", "input[type=file]"),
      step("CAPTION", "Caption"),
      step("SHARE_TO_FEED", "Share to feed", { booleanPolarity: "DIRECT" }),
      step("CROSSPOST_FACEBOOK", "Share to Facebook", { booleanPolarity: "DIRECT" }),
      step("COMMENTS", "Turn off commenting", { booleanPolarity: "INVERTED" }),
      step("ADVANCED_SETTINGS", "Advanced settings"),
      step("FINAL_ACTION", "Share")
    ],
    status: "RECORDED",
    createdAt: "2026-08-27T10:00:00Z"
  };

  const normalized = normalizeAutonomousSurfaceContract(original, profile);
  assert.notEqual(normalized.contractId, original.contractId);
  assert.deepEqual(normalized.steps.map((item) => item.stepKey), [
    "OPEN_CREATE", "UPLOAD_MEDIA", "CAPTION", "ADVANCED_SETTINGS", "SHARE_TO_FEED", "CROSSPOST_FACEBOOK", "COMMENTS", "FINAL_ACTION"
  ]);
  assert.equal(normalized.steps.at(-1).actionMode, "BLOCK_ACTION");

  const plan = buildCalibrationReplayPlan(context, normalized);
  assert.equal(plan.actions.at(-1).operation, "FINAL_BOUNDARY");
  assert.equal(plan.actions.find((item) => item.stepKey === "COMMENTS").expectedValue, true, "inverted control must be ON to realize commentsEnabled=false");
  assert.equal(plan.actions.find((item) => item.stepKey === "SHARE_TO_FEED").expectedValue, true);
});

test("missing settings cannot be promoted to a replay contract", () => {
  const incomplete = {
    contractId: "surface:bad",
    accountId: intent.accountId,
    platform: "instagram",
    format: "reel",
    postingProfileId: profile.postingProfileId,
    environment: { browserFamily: "chromium", browserMajor: 140, language: "de-AT", timeZone: "Europe/Vienna", viewportWidth: 1280, viewportHeight: 800, deviceScaleFactor: 1, fingerprint: "environment:v1" },
    steps: [step("UPLOAD_MEDIA", "input[type=file]"), step("CAPTION", "Caption"), step("FINAL_ACTION", "Share")],
    status: "RECORDED",
    createdAt: "2026-08-27T10:00:00Z"
  };
  assert.throws(() => normalizeAutonomousSurfaceContract(incomplete, profile), /SHARE_TO_FEED/);
});
