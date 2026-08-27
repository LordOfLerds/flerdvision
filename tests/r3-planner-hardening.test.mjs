import test from "node:test";
import assert from "node:assert/strict";
import { DistributionPlanner } from "../dist/application/distribution-planner.js";

const day1 = "2026-08-27";
const day2 = "2026-08-28";
const policy = { contentOrder: "FILENAME_NUMERIC_PREFIX", lateArrival: "NEXT_AVAILABLE_SLOT", overflow: "BACKLOG_NEXT_DAY" };
const copy = { copyProfileId: "copy", displayName: "Copy", versionId: "v1", strategy: "template", enabled: true };
const ig = { postingProfileId: "ig", displayName: "IG", platform: "instagram", format: "reel", commentsEnabled: true, shareToFeed: true, crosspostFacebook: false, enabled: true };

function schedule(id, slots, { cap = 4, spacing = 0 } = {}) {
  return {
    timeZone: "Europe/Vienna",
    slots: slots.map((localTime, index) => ({ key: `${id}-${index + 1}`, localTime })),
    windowMinutes: 30,
    maxPerAccountPerBusinessDate: cap,
    minimumSpacingMinutes: spacing,
    overflowAllowed: false,
    overflowMinimumSpacingMinutes: 240
  };
}

function asset(id, laneId, filename, businessDate = day1) {
  return {
    assetId: id,
    contentId: `content-${id}`,
    laneId,
    creatorId: "creator",
    sourceObservationId: `observation-${id}`,
    sourceRef: id,
    externalObjectId: id,
    filename,
    mediaFingerprint: `sha-${id}`,
    observedAt: `${businessDate}T05:00:00.000Z`,
    readyAt: `${businessDate}T05:01:00.000Z`,
    scheduledBusinessDate: businessDate,
    state: "READY",
    metadata: {}
  };
}

function route(id, laneId, accountId, schedulePolicyId) {
  return {
    routeId: id,
    displayName: id,
    laneId,
    accountId,
    platform: "instagram",
    postingProfileId: "ig",
    copyProfileId: "copy",
    schedulePolicyId,
    requirement: "REQUIRED",
    enabled: true
  };
}

function input(overrides = {}) {
  return {
    businessDate: day1,
    generatedAt: `${day1}T06:00:00.000Z`,
    assets: [asset("a1", "lane", "01.mp4")],
    lanes: [{ laneId: "lane", connectionId: "source", displayName: "Lane", folderRef: "f", folderPath: "Lane", interpretation: { kind: "flat" }, enabled: true }],
    routes: [route("r1", "lane", "account", "standard")],
    catalog: {
      postingProfiles: { ig },
      copyProfiles: { copy },
      schedulePolicies: { standard: schedule("slot", ["09:00"]) }
    },
    policy,
    ...overrides
  };
}

test("DailyPlan identity is semantic and does not change with generatedAt", () => {
  const planner = new DistributionPlanner();
  const first = planner.plan(input());
  const second = planner.plan(input({ generatedAt: `${day1}T07:00:00.000Z` }));
  assert.equal(first.planId, second.planId);
  assert.notEqual(first.generatedAt, second.generatedAt);
  assert.deepEqual(first.deliveries, second.deliveries);
});

test("overflow backlog carries an explicitly named asset into the next business date", () => {
  const planner = new DistributionPlanner();
  const assets = [1, 2, 3, 4, 5].map((n) => asset(`a${n}`, "lane", `0${n}.mp4`));
  const dayOne = planner.plan(input({
    assets,
    catalog: { postingProfiles: { ig }, copyProfiles: { copy }, schedulePolicies: { standard: schedule("slot", ["09:00", "11:00", "15:00", "17:00"]) } }
  }));
  assert.equal(dayOne.deliveries.length, 4);
  assert.equal(dayOne.backlog.length, 1);
  assert.equal(dayOne.backlog[0].assetId, "a5");
  assert.equal(dayOne.backlog[0].carryToBusinessDate, day2);

  const dayTwo = planner.plan(input({
    businessDate: day2,
    generatedAt: `${day2}T06:00:00.000Z`,
    assets,
    carryInBacklog: dayOne.backlog,
    catalog: { postingProfiles: { ig }, copyProfiles: { copy }, schedulePolicies: { standard: schedule("next", ["09:00"]) } }
  }));
  assert.equal(dayTwo.deliveries.length, 1);
  assert.equal(dayTwo.deliveries[0].assetId, "a5");
});

test("account-wide daily cap across separate routes fails closed instead of selecting a hidden winner", () => {
  const planner = new DistributionPlanner();
  const result = planner.plan(input({
    assets: [asset("a1", "lane-a", "01.mp4"), asset("b1", "lane-b", "01.mp4")],
    lanes: [
      { laneId: "lane-a", connectionId: "source", displayName: "A", folderRef: "a", folderPath: "A", interpretation: { kind: "flat" }, enabled: true },
      { laneId: "lane-b", connectionId: "source", displayName: "B", folderRef: "b", folderPath: "B", interpretation: { kind: "flat" }, enabled: true }
    ],
    routes: [route("r-a", "lane-a", "same-account", "morning"), route("r-b", "lane-b", "same-account", "later")],
    catalog: {
      postingProfiles: { ig }, copyProfiles: { copy },
      schedulePolicies: { morning: schedule("m", ["09:00"], { cap: 1 }), later: schedule("l", ["11:00"], { cap: 1 }) }
    }
  }));
  assert.equal(result.deliveries.length, 0);
  assert.equal(result.gaps.filter((gap) => gap.kind === "ACCOUNT_DAILY_CAP_CONFLICT").length, 2);
  assert.equal(result.backlog.filter((item) => item.reason === "ACCOUNT_CAP").length, 2);
});

test("account-wide minimum spacing across routes fails closed and carries affected assets", () => {
  const planner = new DistributionPlanner();
  const result = planner.plan(input({
    assets: [asset("a1", "lane-a", "01.mp4"), asset("b1", "lane-b", "01.mp4")],
    lanes: [
      { laneId: "lane-a", connectionId: "source", displayName: "A", folderRef: "a", folderPath: "A", interpretation: { kind: "flat" }, enabled: true },
      { laneId: "lane-b", connectionId: "source", displayName: "B", folderRef: "b", folderPath: "B", interpretation: { kind: "flat" }, enabled: true }
    ],
    routes: [route("r-a", "lane-a", "same-account", "morning"), route("r-b", "lane-b", "same-account", "later")],
    catalog: {
      postingProfiles: { ig }, copyProfiles: { copy },
      schedulePolicies: { morning: schedule("m", ["09:00"], { cap: 4, spacing: 120 }), later: schedule("l", ["10:00"], { cap: 4, spacing: 120 }) }
    }
  }));
  assert.equal(result.deliveries.length, 0);
  assert.equal(result.gaps.filter((gap) => gap.kind === "ACCOUNT_MINIMUM_SPACING_CONFLICT").length, 2);
  assert.equal(result.backlog.filter((item) => item.reason === "ACCOUNT_SPACING").length, 2);
});
