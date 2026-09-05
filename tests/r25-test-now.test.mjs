import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AcceptanceTestNowService } from "../dist/application/acceptance-test-now.js";
import { publicationIntentForDelivery } from "../dist/application/distribution-planner.js";
import { parseWorkspaceSpec } from "../dist/domain/workspace-spec.js";

function fixture(role = "acceptance") {
  const spec = parseWorkspaceSpec({
    schemaVersion: 1,
    workspace: { id: "acceptance", name: "Acceptance", timezone: "Europe/Vienna", runtimeRoot: "/tmp/fv" },
    source: { kind: "local_folder", root: "/tmp/source", structure: "auto", activation: "IMPORT_BACKLOG" },
    customers: [{ key: "kunde-a", name: "Kunde A" }],
    channels: [{ key: "ig-a", name: "Instagram A", customerKey: "kunde-a", platform: "instagram", handle: "kunde_a", formats: [{ type: "reel", times: ["12:00"], sourceMatch: [] }] }]
  });
  const route = { routeId: "route-a", displayName: "Kunde A Reel", laneId: "lane-a", accountId: "account:instagram:ig-a", platform: "instagram", postingProfileId: "posting-a", copyProfileId: "copy-a", schedulePolicyId: "schedule-a", requirement: "REQUIRED", enabled: true };
  const configValue = {
    revision: 1,
    updatedAt: "2026-09-05T10:00:00.000Z",
    config: {
      sources: [{ connectionId: "source-a", displayName: "Source", kind: "local_folder", rootRef: "/tmp/source", enabled: true, disposition: { mode: "database_only", leavePartialUntouched: true, leaveBlockedUntouched: true } }],
      lanes: [{ laneId: "lane-a", connectionId: "source-a", displayName: "Lane", folderRef: ".", folderPath: ".", interpretation: { kind: "flat" }, enabled: true, creatorId: "creator-a" }],
      postingProfiles: [{ postingProfileId: "posting-a", displayName: "IG Reel", enabled: true, platform: "instagram", format: "reel", commentsEnabled: true, shareToFeed: true, crosspostFacebook: false }],
      copyProfiles: [{ copyProfileId: "copy-a", displayName: "Copy", versionId: "copy-v1", strategy: "template", enabled: true }],
      routes: [route],
      activationCursors: [{ laneId: "lane-a", mode: "IMPORT_BACKLOG", activatedAt: "2026-09-05T10:00:00.000Z" }]
    },
    schedulePolicies: {
      "schedule-a": { timeZone: "Europe/Vienna", slots: [{ key: "noon", localTime: "12:00" }], windowMinutes: 30, maxPerAccountPerBusinessDate: 1, minimumSpacingMinutes: 0, overflowAllowed: false, overflowMinimumSpacingMinutes: 240, catchUpHours: 6 }
    },
    planningPolicy: { contentOrder: "FILENAME_NUMERIC_PREFIX", lateArrival: "NEXT_AVAILABLE_SLOT", overflow: "BACKLOG_NEXT_DAY" }
  };
  const assets = [
    { assetId: "asset-1", contentId: "content-1", laneId: "lane-a", creatorId: "creator-a", sourceObservationId: "obs-1", sourceRef: "1.mp4", externalObjectId: "1", filename: "01 First.mp4", mediaFingerprint: "sha-1", observedAt: "2026-09-05T10:00:00.000Z", readyAt: "2026-09-05T10:01:00.000Z", state: "READY", metadata: {} },
    { assetId: "asset-2", contentId: "content-2", laneId: "lane-a", creatorId: "creator-a", sourceObservationId: "obs-2", sourceRef: "2.mp4", externalObjectId: "2", filename: "02 Second.mp4", mediaFingerprint: "sha-2", observedAt: "2026-09-05T10:02:00.000Z", readyAt: "2026-09-05T10:03:00.000Z", state: "READY", metadata: {} }
  ];
  let currentPlan = null;
  const intents = new Map();
  const reservations = new Map();
  const planProvenance = new Map();
  const intentByDelivery = new Map();
  const state = {
    latestDailyPlan() { return currentPlan ? { plan: currentPlan, recordedAt: currentPlan.generatedAt } : null; },
    putDailyPlan(plan) { currentPlan = plan; return { created: true, record: { plan, recordedAt: plan.generatedAt } }; },
    listDailyPlans() { return currentPlan ? [{ plan: currentPlan, recordedAt: currentPlan.generatedAt }] : []; },
    listCurrentDailyPlans() { return currentPlan ? [{ plan: currentPlan, recordedAt: currentPlan.generatedAt }] : []; },
    putAsset() { throw new Error("not used"); },
    getAsset(assetId) { const asset = assets.find((item) => item.assetId === assetId); return asset ? { asset, version: 1, recordedAt: asset.observedAt } : null; },
    listAssets() { return assets.map((asset) => ({ asset, version: 1, recordedAt: asset.observedAt })); },
    putRouteTestReadiness() { throw new Error("not used"); }, latestRouteTestReadiness() { return null; }, listRouteTestReadiness() { return []; }
  };
  const provenance = {
    putPlan(value, now) { planProvenance.set(value.planId, { provenance: value, recordedAt: now }); return { created: true, record: { provenance: value, recordedAt: now } }; },
    getPlan(planId) { return planProvenance.get(planId) ?? null; },
    putIntent(envelope, now) { const record = { envelope, recordedAt: now }; intentByDelivery.set(envelope.provenance.deliveryId, record); return { created: true, record }; },
    getIntent(intentId) { return [...intentByDelivery.values()].find((item) => item.envelope.intent.intentId === intentId) ?? null; },
    getIntentByDelivery(deliveryId) { return intentByDelivery.get(deliveryId) ?? null; }
  };
  const control = {
    createOrGetIntent() { throw new Error("materializer fake owns creation"); },
    getIntent(id) { return intents.get(id) ?? null; },
    listIntents(states) { const all = [...intents.values()]; return states ? all.filter((item) => states.includes(item.state)) : all; },
    transitionIntent(id, to, now) { const current = intents.get(id); if (!current) throw new Error("missing intent"); const next = { ...current, state: to, updatedAt: now }; intents.set(id, next); return next; },
    reserveIntent() { throw new Error("materializer fake owns reservation"); },
    getReservationForIntent(id) { return reservations.get(id) ?? null; },
    listReservations(accountId, businessDate) { return [...reservations.values()].filter((item) => (!accountId || item.accountId === accountId) && (!businessDate || item.businessDate === businessDate)); },
    listDueReservations() { return []; }, listMissedReservations() { return []; }
  };
  const materializer = {
    async ensureIntents(plan, now) {
      const delivery = plan.deliveries[0];
      const intent = publicationIntentForDelivery(delivery);
      const record = { intent, state: "SCHEDULED", createdAt: now, updatedAt: now };
      intents.set(intent.intentId, record);
      reservations.set(intent.intentId, { reservationId: `reservation:${intent.intentId}`, intentId: intent.intentId, accountId: intent.accountId, platform: intent.platform, businessDate: delivery.businessDate, slotKey: delivery.slotKey, targetAt: delivery.scheduledFor, windowStartAt: delivery.windowStartAt, windowEndAt: delivery.windowEndAt, createdAt: now });
      provenance.putIntent({ intent, provenance: { planId: plan.planId, deliveryId: delivery.deliveryId, routeId: delivery.routeId, laneId: delivery.laneId, assetId: delivery.assetId, postingProfileId: delivery.postingProfileId, copyProfileId: delivery.copyProfileId, schedulePolicyId: delivery.schedulePolicyId, routeSnapshotFingerprint: "test", postingProfileSnapshot: configValue.config.postingProfiles[0] } }, now);
      return { created: 1, existing: 0, blocked: 0 };
    }
  };
  const executions = [];
  const execution = {
    async runIntent(intentId, channelKey, now) {
      executions.push({ intentId, channelKey, now });
      control.transitionIntent(intentId, "VERIFIED", now);
    }
  };
  const service = new AcceptanceTestNowService({ spec, role, config: { load: () => configValue }, state, provenance, control, materializer, execution });
  return { service, assets, intents, reservations, executions, getPlan: () => currentPlan, setIntent: (record) => intents.set(record.intent.intentId, record) };
}

test("production role refuses test-now before touching state", async () => {
  const f = fixture("production");
  await assert.rejects(() => f.service.run({ customer: "Kunde A", platform: "instagram", now: "2026-09-05T13:00:00.000Z" }), /nur in einer Acceptance-Installation/);
  assert.equal(f.getPlan(), null);
  assert.equal(f.executions.length, 0);
});

test("acceptance test-now creates one ordinary scheduled intent then delegates exact execution", async () => {
  const f = fixture();
  const result = await f.service.run({ customer: "Kunde A", platform: "instagram", now: "2026-09-05T13:00:00.000Z" });
  assert.equal(result.state, "VERIFIED");
  assert.equal(result.videoLabel, "01 First.mp4");
  assert.equal(f.executions.length, 1);
  assert.equal(f.executions[0].channelKey, "ig-a");
  assert.equal(f.intents.size, 1);
  const plan = f.getPlan();
  assert.equal(plan.deliveries.length, 1);
  assert.match(plan.deliveries[0].slotKey, /^test-now:kunde-a:instagram:/);
  assert.equal(f.reservations.get(f.executions[0].intentId).targetAt, "2026-09-05T13:00:00.000Z");
});

test("an asset already bound in today's plan is never reused", async () => {
  const f = fixture();
  const first = await f.service.run({ customer: "Kunde A", platform: "instagram", now: "2026-09-05T13:00:00.000Z" });
  assert.equal(first.videoLabel, "01 First.mp4");
  const second = await f.service.run({ customer: "Kunde A", platform: "instagram", now: "2026-09-05T14:00:00.000Z" });
  assert.equal(second.videoLabel, "02 Second.mp4");
  assert.equal(f.intents.size, 2);
});

test("PUBLISH_UNCERTAIN on the account blocks any new test-now", async () => {
  const f = fixture();
  const intent = { intentId: "uncertain", contentId: "other", creatorId: "creator-a", platform: "instagram", accountId: "account:instagram:ig-a", format: "reel", copyVersionId: "copy-v1", scheduledFor: "2026-09-05T10:00:00.000Z", idempotencyKey: "uncertain" };
  f.setIntent({ intent, state: "PUBLISH_UNCERTAIN", createdAt: intent.scheduledFor, updatedAt: intent.scheduledFor });
  await assert.rejects(() => f.service.run({ customer: "Kunde A", platform: "instagram", now: "2026-09-05T13:00:00.000Z" }), /PUBLISH_UNCERTAIN/);
  assert.equal(f.executions.length, 0);
});

test("test-now command uses production publisher/due classes and never private-e2e", () => {
  const source = readFileSync(new URL("../src/application/acceptance-test-now-command.ts", import.meta.url).pathname, "utf8");
  const cli = readFileSync(new URL("../src/cli/flerdvision.ts", import.meta.url).pathname, "utf8");
  assert.match(source, /new WorkspaceSurfacePublisher/);
  assert.match(source, /new AuthorizedRuntimeDueExecutionAdapter/);
  assert.match(source, /new CompositeOperationalPublishGate/);
  assert.doesNotMatch(source, /WorkspacePrivateE2ECommands|runHeadlessDemo/);
  assert.match(cli, /test-now <kunde>/);
  assert.match(cli, /FLERDVISION_WORKSPACE_ROLE=acceptance/);
});
