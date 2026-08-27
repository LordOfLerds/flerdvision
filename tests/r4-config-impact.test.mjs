import test from "node:test";
import assert from "node:assert/strict";
import {
  assertConfigurationReferentialIntegrity,
  impactOfActivationCursorChange,
  impactOfCopyProfileChange,
  impactOfLaneChange,
  impactOfPostingProfileChange,
  impactOfRouteChange,
  impactOfSourceChange
} from "../dist/application/distribution-config.js";

const config = {
  sources: [{ connectionId: "src", displayName: "Drive", kind: "google_drive", rootRef: "root", enabled: true, disposition: { mode: "database_only", leavePartialUntouched: true, leaveBlockedUntouched: true } }],
  lanes: [
    { laneId: "lane-a", connectionId: "src", displayName: "A", folderRef: "a", folderPath: "A", interpretation: { kind: "flat" }, enabled: true },
    { laneId: "lane-b", connectionId: "src", displayName: "B", folderRef: "b", folderPath: "B", interpretation: { kind: "flat" }, enabled: true }
  ],
  postingProfiles: [{ postingProfileId: "ig", displayName: "IG", platform: "instagram", format: "reel", commentsEnabled: true, shareToFeed: true, crosspostFacebook: false, enabled: true }],
  copyProfiles: [{ copyProfileId: "copy", displayName: "Copy", versionId: "v1", strategy: "template", enabled: true }],
  activationCursors: [{ laneId: "lane-a", mode: "NEW_ONLY", activatedAt: "2026-08-27T06:00:00.000Z" }],
  routes: [
    { routeId: "r1", displayName: "R1", laneId: "lane-a", accountId: "ig1", platform: "instagram", postingProfileId: "ig", copyProfileId: "copy", schedulePolicyId: "default", requirement: "REQUIRED", enabled: true },
    { routeId: "r2", displayName: "R2", laneId: "lane-b", accountId: "ig1", platform: "instagram", postingProfileId: "ig", copyProfileId: "copy", schedulePolicyId: "default", requirement: "OPTIONAL", enabled: true }
  ]
};

test("source and lane changes invalidate only dependent future routes and require a new activation boundary", () => {
  const source = impactOfSourceChange(config, "src");
  assert.deepEqual(source.affectedRouteIds, ["r1", "r2"]);
  assert.equal(source.requireActivationCursor, true);
  assert.equal(source.requireRouteRetest, true);
  assert.equal(source.preserveVerifiedPublications, true);

  const lane = impactOfLaneChange(config, "lane-a");
  assert.deepEqual(lane.affectedRouteIds, ["r1"]);
  assert.equal(lane.invalidateFutureDailyPlans, true);
});

test("posting behaviour change invalidates future plans and route qualification but never history", () => {
  const impact = impactOfPostingProfileChange(config, "ig");
  assert.deepEqual(impact.affectedRouteIds, ["r1", "r2"]);
  assert.equal(impact.requireRouteRetest, true);
  assert.equal(impact.preserveHistoricalAudit, true);
});

test("copy change requires new future intent version without forcing platform retest", () => {
  const impact = impactOfCopyProfileChange(config, "copy");
  assert.equal(impact.invalidateFutureDailyPlans, true);
  assert.equal(impact.requireRouteRetest, false);
});

test("pausing/changing one route does not claim to mutate published history", () => {
  const impact = impactOfRouteChange(config, "r1");
  assert.deepEqual(impact.affectedRouteIds, ["r1"]);
  assert.equal(impact.preserveVerifiedPublications, true);
  assert.equal(impact.preserveHistoricalAudit, true);
});

test("referential integrity rejects orphan routes and lanes before UI save", () => {
  assert.doesNotThrow(() => assertConfigurationReferentialIntegrity(config));
  assert.throws(() => assertConfigurationReferentialIntegrity({ ...config, routes: [{ ...config.routes[0], laneId: "missing" }] }), /missing lane/);
  assert.throws(() => assertConfigurationReferentialIntegrity({ ...config, lanes: [{ ...config.lanes[0], connectionId: "missing" }] }), /missing source/);
});

test("activation cursor changes invalidate future planning without forcing a platform retest", () => {
  const impact = impactOfActivationCursorChange(config, "lane-a");
  assert.deepEqual(impact.affectedRouteIds, ["r1"]);
  assert.equal(impact.invalidateFutureDailyPlans, true);
  assert.equal(impact.requireRouteRetest, false);
});

test("new route is treated as planning-impacting and requires qualification", () => {
  const impact = impactOfRouteChange(config, "new-route");
  assert.deepEqual(impact.affectedRouteIds, ["new-route"]);
  assert.equal(impact.invalidateFutureDailyPlans, true);
  assert.equal(impact.requireRouteRetest, true);
});
