import test from "node:test";
import assert from "node:assert/strict";
import { DistributionPlanner } from "../dist/application/distribution-planner.js";

// The real acceptance source is a plain Drive folder (01_TestCreator/flerdvision-test-reel-01.mp4):
// no week/day naming, so the ingress interpreter derives no scheduledBusinessDate. The planner
// demanded scheduledBusinessDate === businessDate with no branch for unset, so an asset from any
// simple topology could never be planned at all -- the lordoflerds qualification ended with
// "0 deliveries · 2 gaps · MISSING_CONTENT" against a READY asset on the exact configured lane.

const schedule = {
  timeZone: "Europe/Vienna",
  slots: [{ key: "s1", localTime: "12:00" }, { key: "s2", localTime: "19:00" }],
  windowMinutes: 30,
  maxPerAccountPerBusinessDate: 2,
  minimumSpacingMinutes: 120,
  overflowAllowed: false,
  overflowMinimumSpacingMinutes: 240
};

const lane = {
  laneId: "lane:test", connectionId: "source:drive", displayName: "Test", folderRef: "ref",
  folderPath: "01_TestCreator", interpretation: { kind: "flat" }, enabled: true
};

const catalog = {
  postingProfiles: { ig: { postingProfileId: "ig", displayName: "IG", platform: "instagram", format: "reel", commentsEnabled: true, shareToFeed: true, crosspostFacebook: false, enabled: true } },
  copyProfiles: { std: { copyProfileId: "std", displayName: "Std", versionId: "v1", strategy: "template", enabled: true } },
  schedulePolicies: { std: schedule }
};

const route = {
  routeId: "route:ig", displayName: "Test -> IG", laneId: lane.laneId, accountId: "ig:test", platform: "instagram",
  postingProfileId: "ig", copyProfileId: "std", schedulePolicyId: "std", requirement: "REQUIRED", enabled: true
};

function asset(n, extra = {}) {
  return {
    assetId: `asset:${n}`, contentId: `content:${n}`, laneId: lane.laneId, creatorId: "test",
    sourceObservationId: `obs:${n}`, sourceRef: `gdrive://file/${n}`, externalObjectId: `file-${n}`,
    filename: `${String(n).padStart(2, "0")}_video.mp4`, mediaFingerprint: `sha-${n}`,
    observedAt: "2026-08-29T07:55:00.000Z", readyAt: "2026-08-29T08:00:00.000Z",
    state: "READY", metadata: {}, ...extra
  };
}

function plan(assets) {
  return new DistributionPlanner().plan({
    businessDate: "2026-08-29",
    generatedAt: "2026-08-29T19:10:00.000Z",
    assets, lanes: [lane], routes: [route], catalog,
    policy: { contentOrder: "FILENAME_NUMERIC_PREFIX", lateArrival: "NEXT_AVAILABLE_SLOT", overflow: "BACKLOG_NEXT_DAY" }
  });
}

test("an asset without scheduledBusinessDate fills the current business date", () => {
  const result = plan([asset(1)]);
  assert.equal(result.deliveries.length, 1);
  assert.equal(result.deliveries[0].assetId, "asset:1");
  assert.equal(result.deliveries[0].slotKey, "s1");
});

test("an asset pinned to a different date stays excluded", () => {
  const result = plan([asset(1, { scheduledBusinessDate: "2026-08-30" })]);
  assert.equal(result.deliveries.length, 0);
  assert.ok(result.gaps.every((gap) => gap.kind === "MISSING_CONTENT"));
});

test("an asset pinned to the current date is planned exactly as before", () => {
  const result = plan([asset(1, { scheduledBusinessDate: "2026-08-29" })]);
  assert.equal(result.deliveries.length, 1);
});

test("pinned-to-today content outranks nothing: order stays filename-numeric among eligible assets", () => {
  const result = plan([asset(2), asset(1, { scheduledBusinessDate: "2026-08-29" })]);
  assert.deepEqual(result.deliveries.map((d) => d.assetId), ["asset:1", "asset:2"]);
});

test("an unpinned asset ready after a slot window closes flows to the next slot", () => {
  // The acceptance asset became READY at 12:36 Vienna -- after the 12:00 +/-30min window --
  // so NEXT_AVAILABLE_SLOT places it on the 19:00 slot. This is the exact shape of the real run.
  const result = plan([asset(1, { readyAt: "2026-08-29T10:36:00.000Z" })]);
  assert.equal(result.deliveries.length, 1);
  assert.equal(result.deliveries[0].slotKey, "s2");
});

// --- committed occupancy: same-day replans must place NEW material on free slots ---

test("fresh content lands on the free slot when earlier deliveries pin the others", () => {
  const result = new DistributionPlanner().plan({
    businessDate: "2026-08-29",
    generatedAt: "2026-08-29T19:10:00.000Z",
    assets: [asset(3, { readyAt: "2026-08-29T08:00:00.000Z" })],
    lanes: [lane], routes: [route], catalog,
    policy: { contentOrder: "FILENAME_NUMERIC_PREFIX", lateArrival: "NEXT_AVAILABLE_SLOT", overflow: "BACKLOG_NEXT_DAY" },
    committed: { slotKeys: ["s1"], assetIds: ["asset:1"] }
  });
  assert.equal(result.deliveries.length, 1);
  assert.equal(result.deliveries[0].assetId, "asset:3");
  assert.equal(result.deliveries[0].slotKey, "s2", "the committed s1 must be skipped, not fought over");
});

test("a committed asset is never re-planned even when slots are free", () => {
  const result = new DistributionPlanner().plan({
    businessDate: "2026-08-29",
    generatedAt: "2026-08-29T19:10:00.000Z",
    assets: [asset(1, { readyAt: "2026-08-29T08:00:00.000Z" })],
    lanes: [lane], routes: [route], catalog,
    policy: { contentOrder: "FILENAME_NUMERIC_PREFIX", lateArrival: "NEXT_AVAILABLE_SLOT", overflow: "BACKLOG_NEXT_DAY" },
    committed: { assetIds: ["asset:1"] }
  });
  assert.equal(result.deliveries.length, 0);
});
