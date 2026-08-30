import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildCalibrationReplayPlan } from "../dist/application/platform-execution-plan.js";

// Live acceptance failure: the private-E2E prepare leg died on "Surface environment drift
// before execution" against its OWN qualification from minutes earlier. The fingerprint pins
// layout-affecting metrics (viewport, device scale) -- rightly, breakpoints change the surface --
// but window size and target display are not deterministic across launches. The executor now
// establishes the contract's recorded metrics via emulation before judging drift; language,
// time zone and browser major still hard-fail because they cannot be emulated away.

const environment = {
  browserFamily: "chromium", browserMajor: 128, language: "de-DE", timeZone: "Europe/Vienna",
  viewportWidth: 1200, viewportHeight: 883, deviceScaleFactor: 2, fingerprint: "fp-1"
};

const contract = {
  contractId: "surface:test", accountId: "acc:1", postingProfileId: "pp:1",
  platform: "instagram", format: "reel", status: "CALIBRATED", environment,
  steps: [
    { stepKey: "OPEN_CREATE", actionMode: "OBSERVE_ACTION", locator: { kind: "role", value: "Erstellen" }, fallbackLocators: [], observations: 1 },
    { stepKey: "FINAL_ACTION", actionMode: "BLOCK_ACTION", locator: { kind: "role", value: "Teilen" }, fallbackLocators: [], observations: 1 }
  ]
};

const context = {
  intent: { intentId: "intent:1", accountId: "acc:1", platform: "instagram", format: "reel", contentId: "c", creatorId: "cr", copyVersionId: "v", scheduledFor: "2026-08-30T08:20:00.000Z", idempotencyKey: "k" },
  provenance: { planId: "p", deliveryId: "d", routeId: "r", laneId: "l", assetId: "a", postingProfileId: "pp:1", copyProfileId: "cp", schedulePolicyId: "sp", routeSnapshotFingerprint: "f" },
  postingProfile: { postingProfileId: "pp:1", displayName: "IG", platform: "instagram", format: "reel", commentsEnabled: true, shareToFeed: true, crosspostFacebook: false, enabled: true }
};

test("execution plans carry the full contract environment, not only its hash", () => {
  const plan = buildCalibrationReplayPlan(context, contract);
  assert.equal(plan.environmentFingerprint, "fp-1");
  assert.deepEqual(plan.environment, environment);
});

const runner = readFileSync(new URL("../src/adapters/browser/platform-execution-runner.ts", import.meta.url).pathname, "utf8");

test("the runner establishes the contract metrics before judging drift", () => {
  const establish = runner.indexOf("this.session.setViewport({width:plan.environment.viewportWidth");
  const read = runner.indexOf("const environment=await this.recorder.environment(this.session);");
  const judge = runner.indexOf("Surface environment drift before execution");
  assert.ok(establish > 0, "setViewport call missing");
  assert.ok(establish < read && read < judge, "emulation must run before the environment is read and judged");
});

test("the drift check itself survives: unemulatable drift still fails", () => {
  assert.match(runner, /if\(environment\.fingerprint!==plan\.environmentFingerprint\)throw new UiActionExecutionError/);
});

const cdp = readFileSync(new URL("../src/adapters/browser/chromium-cdp.ts", import.meta.url).pathname, "utf8");

test("setViewport maps to CDP device-metrics override in desktop mode", () => {
  assert.match(cdp, /Emulation\.setDeviceMetricsOverride/);
  const idx = cdp.indexOf("Emulation.setDeviceMetricsOverride");
  assert.match(cdp.slice(idx, idx + 200), /mobile: false/);
});
