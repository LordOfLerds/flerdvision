import test from "node:test";
import assert from "node:assert/strict";
import { aggregateDeliveryStatus, isAssetReady } from "../dist/domain/distribution.js";
import { DistributionPlanner, publicationIntentForDelivery } from "../dist/application/distribution-planner.js";

const schedule = {
  timeZone: "Europe/Vienna",
  slots: [
    { key: "s1", localTime: "09:00" },
    { key: "s2", localTime: "11:00" },
    { key: "s3", localTime: "15:00" },
    { key: "s4", localTime: "17:00" }
  ],
  windowMinutes: 30,
  maxPerAccountPerBusinessDate: 4,
  minimumSpacingMinutes: 120,
  overflowAllowed: false,
  overflowMinimumSpacingMinutes: 240
};

const lane = {
  laneId: "lane:piet-main",
  connectionId: "source:drive",
  displayName: "Piet Main",
  folderRef: "opaque-folder",
  folderPath: "Piet / Mittwoch",
  interpretation: { kind: "flat" },
  enabled: true
};

const catalog = {
  postingProfiles: {
    "ig-normal": {
      postingProfileId: "ig-normal", displayName: "IG Normal", platform: "instagram", format: "reel",
      commentsEnabled: true, shareToFeed: true, crosspostFacebook: false, enabled: true
    },
    "tt-public": {
      postingProfileId: "tt-public", displayName: "TT Public", platform: "tiktok", format: "tiktok",
      visibility: "everyone", commentsEnabled: true, duetEnabled: true, stitchEnabled: true, enabled: true
    }
  },
  copyProfiles: {
    standard: { copyProfileId: "standard", displayName: "Standard", versionId: "copy-v7", strategy: "template", enabled: true }
  },
  schedulePolicies: { standard: schedule }
};

const routes = [
  {
    routeId: "route:ig", displayName: "Piet -> Instagram", laneId: lane.laneId, accountId: "ig:piet", platform: "instagram",
    postingProfileId: "ig-normal", copyProfileId: "standard", schedulePolicyId: "standard", requirement: "REQUIRED", enabled: true
  },
  {
    routeId: "route:tt", displayName: "Piet -> TikTok", laneId: lane.laneId, accountId: "tt:piet", platform: "tiktok",
    postingProfileId: "tt-public", copyProfileId: "standard", schedulePolicyId: "standard", requirement: "REQUIRED", enabled: true
  }
];

function asset(n, extra = {}) {
  return {
    assetId: `asset:${n}`,
    contentId: `content:${n}`,
    laneId: lane.laneId,
    creatorId: "piet",
    sourceObservationId: `obs:${n}`,
    sourceRef: `gdrive://file/${n}`,
    externalObjectId: `file-${n}`,
    filename: `${String(n).padStart(2, "0")}_video.mp4`,
    mediaFingerprint: `sha-${n}`,
    observedAt: `2026-08-27T05:0${n}:00.000Z`,
    readyAt: `2026-08-27T05:1${n}:00.000Z`,
    scheduledBusinessDate: "2026-08-27",
    state: "READY",
    metadata: {},
    ...extra
  };
}

const policy = { contentOrder: "FILENAME_NUMERIC_PREFIX", lateArrival: "NEXT_AVAILABLE_SLOT", overflow: "BACKLOG_NEXT_DAY" };

function plan(assets, routeSet = routes, overrides = {}) {
  return new DistributionPlanner().plan({
    businessDate: "2026-08-27",
    generatedAt: "2026-08-27T06:30:00.000Z",
    assets,
    lanes: [lane],
    routes: routeSet,
    catalog,
    policy: { ...policy, ...overrides }
  });
}

test("one lane can fan out to Instagram and TikTok without duplicating the source asset", () => {
  const result = plan([asset(1), asset(2), asset(3), asset(4)]);
  assert.equal(result.deliveries.length, 8);
  assert.deepEqual(result.deliveries.filter(d => d.routeId === "route:ig").map(d => d.assetId), ["asset:1", "asset:2", "asset:3", "asset:4"]);
  assert.deepEqual(result.deliveries.filter(d => d.routeId === "route:tt").map(d => d.assetId), ["asset:1", "asset:2", "asset:3", "asset:4"]);
  assert.equal(result.gaps.length, 0);
});

test("three assets produce an explicit missing-content gap for the fourth slot on each route", () => {
  const result = plan([asset(1), asset(2), asset(3)]);
  assert.equal(result.deliveries.length, 6);
  assert.equal(result.gaps.filter(g => g.kind === "MISSING_CONTENT").length, 2);
  assert.ok(result.gaps.every(g => g.slotKey === "s4"));
});

test("overflow becomes backlog rather than an unsafe fifth publish", () => {
  const result = plan([asset(1), asset(2), asset(3), asset(4), asset(5)]);
  assert.equal(result.deliveries.length, 8);
  assert.equal(result.backlog.length, 2);
  assert.ok(result.backlog.every(item => item.assetId === "asset:5" && item.reason === "NEXT_DAY"));
});

test("late asset under NEXT_AVAILABLE_SLOT is preserved for the next still-valid slot", () => {
  const late = asset(1, { readyAt: "2026-08-27T08:45:00.000Z" });
  const result = plan([late], [routes[0]]);
  assert.equal(result.deliveries.length, 1);
  assert.equal(result.deliveries[0].slotKey, "s2");
  assert.equal(result.gaps[0].kind, "MISSING_CONTENT");
  assert.equal(result.gaps[0].slotKey, "s1");
});

test("manual late-arrival policy does not silently schedule the asset", () => {
  const late = asset(1, { readyAt: "2026-08-27T08:45:00.000Z" });
  const result = plan([late], [routes[0]], { lateArrival: "MANUAL_REVIEW" });
  assert.equal(result.deliveries.length, 0);
  assert.ok(result.gaps.some(g => g.kind === "LATE_ARRIVAL_REQUIRES_REVIEW"));
  assert.ok(result.backlog.some(b => b.reason === "MANUAL_REVIEW"));
});

test("same account and same slot across two lanes fails visibly instead of picking route order", () => {
  const lane2 = { ...lane, laneId: "lane:other", displayName: "Other", folderRef: "other", folderPath: "Other" };
  const otherAsset = { ...asset(9), assetId: "asset:other", contentId: "content:other", laneId: lane2.laneId };
  const conflictRoute = { ...routes[0], routeId: "route:conflict", laneId: lane2.laneId };
  const result = new DistributionPlanner().plan({
    businessDate: "2026-08-27", generatedAt: "2026-08-27T06:30:00.000Z",
    assets: [asset(1), otherAsset], lanes: [lane, lane2], routes: [routes[0], conflictRoute], catalog, policy
  });
  assert.equal(result.deliveries.length, 0);
  assert.equal(result.gaps.filter(g => g.kind === "ACCOUNT_SLOT_CONFLICT").length, 2);
});

test("posting profile platform mismatch is a plan gap, not a malformed intent", () => {
  const bad = { ...routes[0], postingProfileId: "tt-public" };
  const result = plan([asset(1)], [bad]);
  assert.equal(result.deliveries.length, 0);
  assert.equal(result.gaps[0].kind, "ROUTE_CONFIGURATION_INVALID");
});

test("publication intent is deterministic from the planned delivery", () => {
  const delivery = plan([asset(1)], [routes[0]]).deliveries[0];
  const first = publicationIntentForDelivery(delivery);
  const second = publicationIntentForDelivery(delivery);
  assert.deepEqual(first, second);
  assert.equal(first.accountId, "ig:piet");
  assert.equal(first.format, "reel");
  assert.equal(first.copyVersionId, "copy-v7");
});

test("asset readiness requires stable bytes and readable media", () => {
  const a = asset(1, { state: "STABILIZING", readyAt: undefined });
  assert.equal(isAssetReady(a, { assetId: a.assetId, checkedAt: a.observedAt, stableFingerprint: true, stableSize: true, mediaReadable: true, durationSeconds: 7 }), true);
  assert.equal(isAssetReady(a, { assetId: a.assetId, checkedAt: a.observedAt, stableFingerprint: true, stableSize: false, mediaReadable: true, durationSeconds: 7 }), false);
});

test("delivery aggregate completes only when every required delivery is verified or waived", () => {
  const partial = aggregateDeliveryStatus({
    assetId: "a", requiredDeliveryIds: ["ig", "tt"], optionalDeliveryIds: ["story"],
    verifiedDeliveryIds: ["ig"], waivedDeliveryIds: [], failedDeliveryIds: ["tt"]
  });
  assert.equal(partial.status, "PARTIAL");
  const done = aggregateDeliveryStatus({
    assetId: "a", requiredDeliveryIds: ["ig", "tt"], optionalDeliveryIds: ["story"],
    verifiedDeliveryIds: ["ig"], waivedDeliveryIds: ["tt"], failedDeliveryIds: ["story"]
  });
  assert.equal(done.status, "COMPLETE");
});
