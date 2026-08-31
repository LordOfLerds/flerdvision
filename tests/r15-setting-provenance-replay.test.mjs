import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildCalibrationReplayPlan } from "../dist/application/platform-execution-plan.js";

// The exploration already honours operator provenance: a setting the canonical spec never asked
// for is skipped when its control is absent. The replay leg did not, so a recorded-but-undemanded
// COMMENTS step failed every replay with "Cannot prove boolean state" after the operator removed
// it from the spec -- a setting nobody asked for blocking a qualified route.

const environment = { browserFamily: "chromium", browserMajor: 128, language: "de-DE", timeZone: "Europe/Vienna", viewportWidth: 1200, viewportHeight: 883, deviceScaleFactor: 2, fingerprint: "fp" };
const step = (stepKey) => ({ stepKey, actionMode: "OBSERVE_ACTION", locator: { kind: "role", value: stepKey }, fallbackLocators: [], observations: 1 });
const contract = {
  contractId: "surface:test", accountId: "acc", postingProfileId: "pp", platform: "tiktok", format: "tiktok",
  status: "CALIBRATED", environment, steps: [step("COMMENTS"), step("VISIBILITY"), { ...step("FINAL_ACTION"), actionMode: "BLOCK_ACTION" }]
};
function context(explicitSettings) {
  return {
    intent: { intentId: "i", accountId: "acc", platform: "tiktok", format: "tiktok", contentId: "c", creatorId: "cr", copyVersionId: "v", scheduledFor: "2026-08-31T12:00:00.000Z", idempotencyKey: "k" },
    provenance: { planId: "p", deliveryId: "d", routeId: "r", laneId: "l", assetId: "a", postingProfileId: "pp", copyProfileId: "cp", schedulePolicyId: "sp", routeSnapshotFingerprint: "f" },
    postingProfile: { postingProfileId: "pp", displayName: "TT", platform: "tiktok", format: "tiktok", visibility: "only_you", commentsEnabled: true, duetEnabled: true, stitchEnabled: true, enabled: true, ...(explicitSettings ? { explicitSettings } : {}) }
  };
}

test("a setting the spec never demanded is marked undemanded in the plan", () => {
  const plan = buildCalibrationReplayPlan(context(["visibility"]), contract);
  const comments = plan.actions.find((action) => action.stepKey === "COMMENTS");
  assert.equal(comments.operatorDemanded, false);
});

test("a demanded setting stays demanded", () => {
  const plan = buildCalibrationReplayPlan(context(["visibility", "commentsEnabled"]), contract);
  assert.equal(plan.actions.find((action) => action.stepKey === "COMMENTS").operatorDemanded, true);
});

test("undefined provenance keeps every setting demanded", () => {
  const plan = buildCalibrationReplayPlan(context(undefined), contract);
  assert.equal(plan.actions.find((action) => action.stepKey === "COMMENTS").operatorDemanded, true);
});

test("the runner lets an undemanded setting stand at the platform default", () => {
  const runner = readFileSync(new URL("../src/adapters/browser/platform-execution-runner.ts", import.meta.url).pathname, "utf8");
  const idx = runner.indexOf("private async ensureBoolean");
  const block = runner.slice(idx, idx + 1500);
  assert.match(block, /const optional=action\.operatorDemanded===false;/);
  assert.match(block, /platform-default/);
  // A demanded setting must still fail loudly -- that is the point of demanding it.
  assert.match(block, /throw new UiActionExecutionError\(`Cannot prove boolean state/);
  assert.match(block, /throw new UiActionExecutionError\(`Boolean readback failed/);
});
