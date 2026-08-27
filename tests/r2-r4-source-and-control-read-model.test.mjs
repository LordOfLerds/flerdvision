import test from "node:test";
import assert from "node:assert/strict";
import { activationDecision, applyAssetReadinessEvidence } from "../dist/application/source-lifecycle.js";
import { projectControlCenter } from "../dist/application/control-center-read-model.js";

const observation = { observationId: "o1", sourceId: "s", externalObjectId: "file-1", observedAt: "2026-08-27T06:00:00.000Z", locator: "x", metadata: {} };

test("NEW_ONLY activation cursor excludes historical files and accepts files at/after activation", () => {
  const cursor = { laneId: "lane", mode: "NEW_ONLY", activatedAt: "2026-08-27T05:00:00.000Z" };
  assert.equal(activationDecision(cursor, observation), "ACCEPT");
  assert.equal(activationDecision(cursor, { ...observation, observedAt: "2026-08-27T04:59:59.000Z" }), "HISTORICAL");
});

test("SELECTED activation imports only explicitly chosen source objects", () => {
  const cursor = { laneId: "lane", mode: "SELECTED", activatedAt: "2026-08-27T05:00:00.000Z", selectedExternalObjectIds: ["file-2"] };
  assert.equal(activationDecision(cursor, observation), "NOT_SELECTED");
  assert.equal(activationDecision(cursor, { ...observation, externalObjectId: "file-2" }), "ACCEPT");
});

const asset = {
  assetId: "a1", contentId: "c1", laneId: "lane", creatorId: "creator", sourceObservationId: "o1", sourceRef: "x",
  externalObjectId: "file-1", filename: "01.mp4", mediaFingerprint: "sha", observedAt: observation.observedAt,
  state: "OBSERVED", scheduledBusinessDate: "2026-08-27", metadata: {}
};

test("asset stays STABILIZING while cloud bytes are unstable", () => {
  const result = applyAssetReadinessEvidence(asset, { assetId: "a1", checkedAt: observation.observedAt, stableFingerprint: false, stableSize: false, mediaReadable: false }, "2026-08-27T06:01:00.000Z");
  assert.equal(result.asset.state, "STABILIZING");
  assert.equal(result.reason, "still_syncing");
});

test("stable readable asset becomes READY; stable unreadable asset is blocked", () => {
  const ready = applyAssetReadinessEvidence(asset, { assetId: "a1", checkedAt: observation.observedAt, stableFingerprint: true, stableSize: true, mediaReadable: true, durationSeconds: 5 }, "2026-08-27T06:01:00.000Z");
  assert.equal(ready.asset.state, "READY");
  assert.equal(ready.asset.readyAt, "2026-08-27T06:01:00.000Z");
  const blocked = applyAssetReadinessEvidence(asset, { assetId: "a1", checkedAt: observation.observedAt, stableFingerprint: true, stableSize: true, mediaReadable: false }, "2026-08-27T06:01:00.000Z");
  assert.equal(blocked.asset.state, "BLOCKED");
});

test("control center projects Today slots, route readiness, gaps and backlog from the same plan", () => {
  const model = projectControlCenter({
    plan: {
      planId: "p", businessDate: "2026-08-27", generatedAt: "2026-08-27T06:30:00.000Z",
      deliveries: [{ deliveryId: "d1", routeId: "r1", assetId: "a1", contentId: "c1", creatorId: "creator", laneId: "lane", accountId: "ig1", platform: "instagram", format: "reel", postingProfileId: "pp", copyProfileId: "cp", copyVersionId: "v1", requirement: "REQUIRED", businessDate: "2026-08-27", slotKey: "s1", scheduledFor: "2026-08-27T07:00:00.000Z", windowStartAt: "2026-08-27T06:30:00.000Z", windowEndAt: "2026-08-27T07:30:00.000Z" }],
      gaps: [{ gapId: "g1", kind: "MISSING_CONTENT", businessDate: "2026-08-27", routeId: "r1", accountId: "ig1", slotKey: "s4", reason: "No content" }],
      backlog: [{ backlogId: "b1", businessDate: "2026-08-27", routeId: "r1", assetId: "a5", reason: "NEXT_DAY" }]
    },
    sources: [{ connectionId: "src", displayName: "Drive", kind: "google_drive", rootRef: "root", enabled: true, disposition: { mode: "database_only", leavePartialUntouched: true, leaveBlockedUntouched: true } }],
    lanes: [{ laneId: "lane", connectionId: "src", displayName: "Piet", folderRef: "f", folderPath: "Piet / Mittwoch", interpretation: { kind: "flat" }, enabled: true }],
    routes: [{ routeId: "r1", displayName: "Piet IG", laneId: "lane", accountId: "ig1", platform: "instagram", postingProfileId: "pp", copyProfileId: "cp", schedulePolicyId: "sp", requirement: "REQUIRED", enabled: true }],
    postingProfiles: { pp: { postingProfileId: "pp", displayName: "IG Normal", platform: "instagram", format: "reel", commentsEnabled: true, shareToFeed: true, crosspostFacebook: false, enabled: true } },
    accounts: [{ accountId: "ig1", platform: "instagram", expectedHandle: "piet", enabled: true }],
    channelReadiness: [{ accountId: "ig1", sessionHealth: "HEALTHY", identityVerified: true, surfaceContract: "CALIBRATED" }],
    routeTests: [{ routeId: "r1", sourcePassed: true, sessionPassed: true, identityPassed: true, prepareOnlyPasses: 3, secretLivePassed: false, verificationPassed: true, cleanupPassed: false }],
    assets: []
  });
  assert.equal(model.today.totalDeliveries, 1);
  assert.equal(model.today.gaps, 1);
  assert.equal(model.today.backlog, 1);
  assert.equal(model.routes[0].readiness, "READY");
  assert.ok(model.attention.some(item => item.kind === "MISSING_CONTENT" && item.deepLink === "/routes/r1"));
  assert.ok(model.attention.some(item => item.kind === "BACKLOG" && item.deepLink === "/content/a5"));
});

test("route readiness blocks when session is unhealthy and produces action-required attention", () => {
  const model = projectControlCenter({
    plan: { planId: "p", businessDate: "2026-08-27", generatedAt: observation.observedAt, deliveries: [], gaps: [], backlog: [] },
    sources: [],
    lanes: [{ laneId: "lane", connectionId: "src", displayName: "Lane", folderRef: "f", folderPath: "Lane", interpretation: { kind: "flat" }, enabled: true }],
    routes: [{ routeId: "r1", displayName: "Route", laneId: "lane", accountId: "tt1", platform: "tiktok", postingProfileId: "pp", copyProfileId: "cp", schedulePolicyId: "sp", requirement: "REQUIRED", enabled: true }],
    postingProfiles: { pp: { postingProfileId: "pp", displayName: "TT", platform: "tiktok", format: "tiktok", visibility: "everyone", commentsEnabled: true, duetEnabled: true, stitchEnabled: true, enabled: true } },
    accounts: [{ accountId: "tt1", platform: "tiktok", expectedHandle: "piet", enabled: true }],
    channelReadiness: [{ accountId: "tt1", sessionHealth: "AUTH_REQUIRED", identityVerified: true, surfaceContract: "CALIBRATED" }],
    routeTests: [], assets: []
  });
  assert.equal(model.routes[0].readiness, "BLOCKED");
  assert.ok(model.attention.some(item => item.kind === "ROUTE_BLOCKED" && item.severity === "ACTION_REQUIRED"));
});
