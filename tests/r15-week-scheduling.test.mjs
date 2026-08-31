import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DistributionPlanner } from "../dist/application/distribution-planner.js";
import { JsonDistributionConfigurationStore } from "../dist/adapters/distribution/json-config-store.js";
import { SqliteControlPlaneStore } from "../dist/adapters/storage/sqlite.js";
import { WorkspaceSpecCompiler } from "../dist/application/workspace-spec-compiler.js";
import { parseWorkspaceSpec } from "../dist/domain/workspace-spec.js";

// The operator wants one full test week: 21 Instagram videos out of ONE Drive folder,
// three per day for seven consecutive business days, filenames carrying the order
// ("01_Testwelle Mo 0930 LordOfLerds.mp4" ... "21_Testwelle So 1830 LordOfLerds.mp4").
// Nothing below starts a browser: this is pure planning arithmetic over the compiled
// scheduling policy.

const TIMES = ["09:30", "14:00", "18:30"];
const WEEK = ["2026-09-07", "2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11", "2026-09-12", "2026-09-13"];
const DAY_LABEL = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];

function nextBusinessDate(businessDate) {
  const [y, m, d] = businessDate.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

const lane = {
  laneId: "lane:testwelle",
  connectionId: "source:drive",
  displayName: "Testwelle",
  folderRef: "folder-testwelle",
  folderPath: "Drive / Flerdvision / Testwelle",
  interpretation: { kind: "flat" },
  enabled: true
};

function schedulePolicy(times, slotPrefix) {
  const minutes = times.map((value) => {
    const [h, m] = value.split(":").map(Number);
    return h * 60 + m;
  });
  const spacing = times.length <= 1
    ? 0
    : Math.max(15, Math.min(...minutes.slice(1).map((value, index) => value - minutes[index])));
  return {
    timeZone: "Europe/Vienna",
    slots: times.map((localTime, index) => ({ key: `${slotPrefix}-${index + 1}`, localTime })),
    windowMinutes: 30,
    maxPerAccountPerBusinessDate: times.length,
    minimumSpacingMinutes: spacing,
    overflowAllowed: false,
    overflowMinimumSpacingMinutes: 240
  };
}

function instagramProfile(id = "ig-reel") {
  return {
    postingProfileId: id,
    displayName: "LordOfLerds reel",
    platform: "instagram",
    format: "reel",
    commentsEnabled: true,
    shareToFeed: true,
    crosspostFacebook: false,
    enabled: true
  };
}

const copyProfile = {
  copyProfileId: "copy-std",
  displayName: "Filename caption",
  versionId: "copy-v1",
  strategy: "template",
  enabled: true
};

function route(overrides = {}) {
  return {
    routeId: "route:ig",
    displayName: "Testwelle -> LordOfLerds",
    laneId: lane.laneId,
    accountId: "account:instagram:lordoflerds",
    platform: "instagram",
    postingProfileId: "ig-reel",
    copyProfileId: copyProfile.copyProfileId,
    schedulePolicyId: "ig-schedule",
    requirement: "REQUIRED",
    enabled: true,
    ...overrides
  };
}

/** The 21 uploads, all already READY before the week starts and none pinned to a date. */
function weekAssets() {
  return Array.from({ length: 21 }, (_unused, index) => {
    const n = index + 1;
    const day = DAY_LABEL[Math.floor(index / 3)];
    const time = TIMES[index % 3].replace(":", "");
    return {
      assetId: `asset:${String(n).padStart(2, "0")}`,
      contentId: `content:${String(n).padStart(2, "0")}`,
      laneId: lane.laneId,
      creatorId: "creator:testwelle",
      sourceObservationId: `obs:${n}`,
      sourceRef: `gdrive://file/${n}`,
      externalObjectId: `file-${n}`,
      filename: `${String(n).padStart(2, "0")}_Testwelle ${day} ${time} LordOfLerds.mp4`,
      mediaFingerprint: `sha-${n}`,
      observedAt: "2026-09-06T18:00:00.000Z",
      readyAt: "2026-09-06T18:05:00.000Z",
      state: "READY",
      metadata: {}
    };
  });
}

const planningPolicy = { contentOrder: "FILENAME_NUMERIC_PREFIX", lateArrival: "NEXT_AVAILABLE_SLOT", overflow: "BACKLOG_NEXT_DAY" };

/**
 * Walks the week the way the runtime does: plan a day, carry that day's backlog into the
 * next, and let the DISPOSITION phase flip fully delivered assets to COMPLETE before the
 * next business date is planned (RuntimeSupervisor order: PLAN ... DISPOSITION).
 */
function runWeek({ routes, catalog, days = WEEK, disposeCompleted = true } = {}) {
  let pool = weekAssets();
  let carryIn = [];
  const plans = [];
  const requiredRouteCount = routes.filter((item) => item.requirement === "REQUIRED").length;
  const deliveredPerAsset = new Map();
  for (const businessDate of days) {
    const plan = new DistributionPlanner().plan({
      businessDate,
      generatedAt: `${businessDate}T04:00:00.000Z`,
      assets: pool,
      lanes: [lane],
      routes,
      catalog,
      policy: planningPolicy,
      ...(carryIn.length > 0 ? { carryInBacklog: carryIn } : {})
    });
    plans.push(plan);
    const nextDate = nextBusinessDate(businessDate);
    carryIn = plan.backlog.filter((item) => item.carryToBusinessDate === nextDate);
    if (disposeCompleted) {
      for (const delivery of plan.deliveries) {
        deliveredPerAsset.set(delivery.assetId, (deliveredPerAsset.get(delivery.assetId) ?? 0) + 1);
      }
      pool = pool.map((asset) =>
        (deliveredPerAsset.get(asset.assetId) ?? 0) >= requiredRouteCount ? { ...asset, state: "COMPLETE" } : asset
      );
    }
  }
  return plans;
}

const singleRouteCatalog = {
  postingProfiles: { "ig-reel": instagramProfile() },
  copyProfiles: { [copyProfile.copyProfileId]: copyProfile },
  schedulePolicies: { "ig-schedule": schedulePolicy(TIMES, "lordoflerds-reel") }
};

// --- 1. the compiled scheduling policy has to be able to carry three posts a day ---

test("the compiler turns three spec times into a policy that admits three posts a day", () => {
  const root = mkdtempSync(join(tmpdir(), "flerdvision-week-compile-"));
  const configDir = join(root, "config");
  const databaseDir = join(root, "database");
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  mkdirSync(databaseDir, { recursive: true, mode: 0o700 });
  const config = new JsonDistributionConfigurationStore(join(configDir, "distribution.json"));
  const control = new SqliteControlPlaneStore(join(databaseDir, "flerdvision.sqlite"));
  try {
    const spec = parseWorkspaceSpec({
      schemaVersion: 1,
      workspace: { id: "testwelle", name: "Testwelle", timezone: "Europe/Vienna" },
      source: { kind: "google_drive", root: "1TestwelleFolder", structure: "auto", activation: "IMPORT_BACKLOG" },
      channels: [{
        key: "ig", name: "LordOfLerds", platform: "instagram", handle: "lordoflerds",
        formats: [{ type: "reel", times: TIMES, sourceMatch: ["testwelle"], verificationMarker: true }]
      }]
    });
    const topology = {
      rootId: "1TestwelleFolder",
      rootPath: "Drive / Flerdvision",
      verified: true,
      warnings: [],
      nodes: [{ folderId: "testwelle", folderRef: "testwelle", folderPath: "Drive / Flerdvision / Testwelle", name: "Testwelle", depth: 1, directVideoCount: 21, totalVideoCount: 21, childFolderCount: 0 }],
      streams: [{ channelKey: "ig", platform: "instagram", format: "reel", folderRef: "testwelle", folderPath: "Drive / Flerdvision / Testwelle", totalVideoCount: 21, matchedBy: "explicit", score: 30 }]
    };
    new WorkspaceSpecCompiler(config, control, configDir).compile(spec, topology, "2026-09-06T10:00:00Z");
    const policies = Object.values(config.load().schedulePolicies);
    assert.equal(policies.length, 1);
    const policy = policies[0];
    assert.deepEqual(policy.slots.map((slot) => slot.localTime), TIMES);
    assert.ok(
      policy.maxPerAccountPerBusinessDate >= policy.slots.length,
      `daily cap ${policy.maxPerAccountPerBusinessDate} must not be below the ${policy.slots.length} slots the operator configured`
    );
    assert.equal(policy.minimumSpacingMinutes, 270, "09:30/14:00/18:30 are 270 minutes apart");
    assert.ok(policy.windowMinutes > 0);
  } finally {
    control.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
  }
});

test("a second format on one channel does not starve the account it belongs to", () => {
  // Regression: the compiler derived maxPerAccountPerBusinessDate and minimumSpacingMinutes per
  // FORMAT, while the planner enforces both per ACCOUNT. A channel with reel 3x + story 2x
  // therefore planned five deliveries against an effective cap of two -- the planner dropped the
  // whole day as ACCOUNT_DAILY_CAP_CONFLICT and the backlog grew forever without a single post.
  const root = mkdtempSync(join(tmpdir(), "flerdvision-week-multiformat-"));
  const configDir = join(root, "config");
  const databaseDir = join(root, "database");
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  mkdirSync(databaseDir, { recursive: true, mode: 0o700 });
  const config = new JsonDistributionConfigurationStore(join(configDir, "distribution.json"));
  const control = new SqliteControlPlaneStore(join(databaseDir, "flerdvision.sqlite"));
  try {
    const spec = parseWorkspaceSpec({
      schemaVersion: 1,
      workspace: { id: "testwelle", name: "Testwelle", timezone: "Europe/Vienna" },
      source: { kind: "google_drive", root: "1TestwelleFolder", structure: "auto", activation: "IMPORT_BACKLOG" },
      channels: [{
        key: "ig", name: "LordOfLerds", platform: "instagram", handle: "lordoflerds",
        formats: [
          { type: "reel", times: TIMES, sourceMatch: ["testwelle"], verificationMarker: true },
          { type: "story", times: ["11:00", "16:00"], sourceMatch: ["testwelle"], requirement: "OPTIONAL", verificationMarker: false }
        ]
      }]
    });
    const stream = (format) => ({ channelKey: "ig", platform: "instagram", format, folderRef: "testwelle", folderPath: "Drive / Flerdvision / Testwelle", totalVideoCount: 21, matchedBy: "explicit", score: 30 });
    const topology = {
      rootId: "1TestwelleFolder",
      rootPath: "Drive / Flerdvision",
      verified: true,
      warnings: [],
      nodes: [{ folderId: "testwelle", folderRef: "testwelle", folderPath: "Drive / Flerdvision / Testwelle", name: "Testwelle", depth: 1, directVideoCount: 21, totalVideoCount: 21, childFolderCount: 0 }],
      streams: [stream("reel"), stream("story")]
    };
    new WorkspaceSpecCompiler(config, control, configDir).compile(spec, topology, "2026-09-06T10:00:00Z");
    const stored = config.load();
    for (const policy of Object.values(stored.schedulePolicies)) {
      assert.equal(policy.maxPerAccountPerBusinessDate, 5, "the cap counts every post the account is configured to make in a day");
      assert.equal(policy.minimumSpacingMinutes, 90, "09:30/11:00/14:00/16:00/18:30 are 90 minutes apart at the closest");
    }
    const catalog = {
      postingProfiles: Object.fromEntries(stored.config.postingProfiles.map((item) => [item.postingProfileId, item])),
      copyProfiles: Object.fromEntries(stored.config.copyProfiles.map((item) => [item.copyProfileId, item])),
      schedulePolicies: stored.schedulePolicies
    };
    const compiledLane = stored.config.lanes[0];
    const plan = new DistributionPlanner().plan({
      businessDate: "2026-09-07",
      generatedAt: "2026-09-07T04:00:00.000Z",
      assets: weekAssets().map((asset) => ({ ...asset, laneId: compiledLane.laneId })),
      lanes: [compiledLane],
      routes: stored.config.routes,
      catalog,
      policy: stored.planningPolicy
    });
    assert.equal(plan.deliveries.length, 5, `expected reel 3x + story 2x, got gaps ${JSON.stringify(plan.gaps.map((gap) => gap.kind))}`);
    assert.equal(plan.gaps.length, 0);
    assert.ok(plan.backlog.every((item) => item.reason === "NEXT_DAY"), "leftover content is ordinary overflow, not a cap or spacing casualty");
  } finally {
    control.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
  }
});

// --- 2. the full week ---

test("21 unpinned assets fill seven business days with exactly three deliveries each", () => {
  const plans = runWeek({ routes: [route()], catalog: singleRouteCatalog });
  assert.equal(plans.length, 7);
  for (const [index, plan] of plans.entries()) {
    assert.equal(plan.deliveries.length, 3, `${WEEK[index]} planned ${plan.deliveries.length} deliveries: ${JSON.stringify(plan.gaps.map((gap) => gap.kind))}`);
  }
});

test("the week runs the filenames in numeric order and neither loses nor repeats one", () => {
  const plans = runWeek({ routes: [route()], catalog: singleRouteCatalog });
  const order = plans.flatMap((plan) => plan.deliveries.map((delivery) => delivery.assetId));
  const expected = Array.from({ length: 21 }, (_unused, index) => `asset:${String(index + 1).padStart(2, "0")}`);
  assert.deepEqual(order, expected);
  assert.equal(new Set(order).size, 21, "no asset may be planned twice across the week");
});

test("every planned day keeps the configured slots, spacing and window", () => {
  const plans = runWeek({ routes: [route()], catalog: singleRouteCatalog });
  const spacing = singleRouteCatalog.schedulePolicies["ig-schedule"].minimumSpacingMinutes;
  for (const plan of plans) {
    assert.deepEqual(plan.deliveries.map((delivery) => delivery.slotKey), ["lordoflerds-reel-1", "lordoflerds-reel-2", "lordoflerds-reel-3"]);
    for (let i = 1; i < plan.deliveries.length; i += 1) {
      const gapMinutes = (Date.parse(plan.deliveries[i].scheduledFor) - Date.parse(plan.deliveries[i - 1].scheduledFor)) / 60000;
      assert.ok(gapMinutes >= spacing, `${plan.businessDate}: ${gapMinutes} min between deliveries is below the ${spacing} min minimum`);
    }
    for (const delivery of plan.deliveries) {
      assert.ok(Date.parse(delivery.windowStartAt) < Date.parse(delivery.scheduledFor));
      assert.ok(Date.parse(delivery.windowEndAt) > Date.parse(delivery.scheduledFor));
    }
    assert.equal(plan.gaps.length, 0, `${plan.businessDate} reported gaps: ${JSON.stringify(plan.gaps)}`);
  }
});

test("the backlog shrinks every day and is empty once the week is planned", () => {
  const plans = runWeek({ routes: [route()], catalog: singleRouteCatalog });
  const sizes = plans.map((plan) => plan.backlog.length);
  assert.deepEqual(sizes, [18, 15, 12, 9, 6, 3, 0], `backlog did not drain: ${JSON.stringify(sizes)}`);
});

test("the eighth day has nothing left to plan instead of replaying the week", () => {
  const plans = runWeek({ routes: [route()], catalog: singleRouteCatalog, days: [...WEEK, "2026-09-14"] });
  const eighth = plans.at(-1);
  assert.equal(eighth.deliveries.length, 0);
  assert.ok(eighth.gaps.every((gap) => gap.kind === "MISSING_CONTENT"));
});

// --- 3. several channels out of one folder ---

const threeChannelCatalog = {
  postingProfiles: {
    "ig-reel": instagramProfile(),
    "tt-post": { postingProfileId: "tt-post", displayName: "TikTok", platform: "tiktok", format: "tiktok", visibility: "everyone", commentsEnabled: true, duetEnabled: true, stitchEnabled: true, enabled: true },
    "yt-short": { postingProfileId: "yt-short", displayName: "YouTube", platform: "youtube", format: "short", visibility: "public", commentsEnabled: true, enabled: true }
  },
  copyProfiles: { [copyProfile.copyProfileId]: copyProfile },
  schedulePolicies: {
    "ig-schedule": schedulePolicy(TIMES, "lordoflerds-reel"),
    "tt-schedule": schedulePolicy(TIMES, "lordoflerds-tiktok"),
    "yt-schedule": schedulePolicy(TIMES, "lordoflerds-short")
  }
};

const threeRoutes = [
  route(),
  route({ routeId: "route:tt", accountId: "account:tiktok:lordoflerds", platform: "tiktok", postingProfileId: "tt-post", schedulePolicyId: "tt-schedule" }),
  route({ routeId: "route:yt", accountId: "account:youtube:lordoflerds", platform: "youtube", postingProfileId: "yt-short", schedulePolicyId: "yt-schedule" })
];

test("three channels on one lane mirror the same asset instead of competing for it", () => {
  const plans = runWeek({ routes: threeRoutes, catalog: threeChannelCatalog });
  for (const [index, plan] of plans.entries()) {
    assert.equal(plan.deliveries.length, 9, `${WEEK[index]} planned ${plan.deliveries.length} of the expected 9 deliveries`);
    const perPlatform = new Map();
    for (const delivery of plan.deliveries) {
      perPlatform.set(delivery.platform, [...(perPlatform.get(delivery.platform) ?? []), delivery.assetId]);
    }
    assert.deepEqual([...perPlatform.keys()].sort(), ["instagram", "tiktok", "youtube"], "every channel must be served, none may starve");
    const [first, ...rest] = [...perPlatform.values()];
    for (const other of rest) assert.deepEqual(other, first, "one lane means one shared running order, not three competing ones");
  }
  const instagramOrder = plans.flatMap((plan) => plan.deliveries.filter((delivery) => delivery.platform === "instagram").map((delivery) => delivery.assetId));
  assert.equal(new Set(instagramOrder).size, 21);
});

test("a shared lane only completes an asset once all required channels delivered it", () => {
  // Documents the coupling the operator has to accept for one folder: an asset is not
  // retired from planning by the first platform, so a channel that lags behind does not
  // silently drop content -- but the whole week advances at the slowest required channel.
  const plans = runWeek({ routes: threeRoutes, catalog: threeChannelCatalog, days: WEEK.slice(0, 2) });
  const dayOne = plans[0].deliveries.map((delivery) => delivery.assetId);
  const dayTwo = plans[1].deliveries.map((delivery) => delivery.assetId);
  assert.equal(new Set(dayOne).size, 3);
  assert.equal(new Set(dayTwo).size, 3);
  assert.equal([...new Set(dayOne)].filter((assetId) => dayTwo.includes(assetId)).length, 0);
});
