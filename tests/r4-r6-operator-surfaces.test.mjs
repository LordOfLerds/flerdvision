import test from "node:test";
import assert from "node:assert/strict";
import { buildRouteTestMatrix } from "../dist/application/route-test-matrix.js";
import { incidentView, sortActivity } from "../dist/application/control-center-operator-surfaces.js";
import { decideSourceDisposition } from "../dist/application/source-disposition-coordinator.js";

const route = { routeId:"r1", displayName:"Piet TikTok secret", laneId:"lane", accountId:"tt1", platform:"tiktok", postingProfileId:"tt-secret", copyProfileId:"copy", schedulePolicyId:"default", requirement:"REQUIRED", enabled:true };
const account = { accountId:"tt1", platform:"tiktok", expectedHandle:"piet", enabled:true };
const channel = { accountId:"tt1", sessionHealth:"HEALTHY", identityVerified:true, surfaceContract:"CALIBRATED" };
const evidence = { routeId:"r1", sourcePassed:true, sessionPassed:true, identityPassed:true, prepareOnlyPasses:3, secretLivePassed:false, verificationPassed:true, cleanupPassed:false };

test("route test matrix is generated from actual route/profile and keeps live-secret separate", () => {
  const profile = { postingProfileId:"tt-secret", displayName:"TikTok Only You", platform:"tiktok", format:"tiktok", visibility:"only_you", commentsEnabled:true, duetEnabled:false, stitchEnabled:false, enabled:true };
  const matrix = buildRouteTestMatrix({ route, profile, account, channel, evidence });
  assert.equal(matrix.overall, "READY");
  assert.equal(matrix.cases.find(x=>x.testKey==="PREPARE_ONLY").status, "PASS");
  assert.equal(matrix.cases.find(x=>x.testKey==="SECRET_LIVE").status, "NOT_RUN");
  assert.match(matrix.cases.find(x=>x.testKey==="SECRET_LIVE").detail, /Only you/);
});

test("Trial Reel and public TikTok modes cannot masquerade as zero-viewer secret-live", () => {
  const igRoute = { ...route, routeId:"ig", accountId:"ig1", platform:"instagram", postingProfileId:"trial" };
  const ig = buildRouteTestMatrix({ route:igRoute, profile:{ postingProfileId:"trial", displayName:"Trial", platform:"instagram", format:"trial_reel", commentsEnabled:true, shareToFeed:false, crosspostFacebook:false, enabled:true }, account:{ accountId:"ig1", platform:"instagram", expectedHandle:"piet", enabled:true }, channel:{ ...channel, accountId:"ig1" }, evidence:{ ...evidence, routeId:"ig" } });
  assert.equal(ig.cases.find(x=>x.testKey==="SECRET_LIVE").status, "BLOCKED");
  assert.match(ig.cases.find(x=>x.testKey==="SECRET_LIVE").detail, /non-followers/);
  const publicTiktok = buildRouteTestMatrix({ route, profile:{ postingProfileId:"tt-secret", displayName:"Public", platform:"tiktok", format:"tiktok", visibility:"everyone", commentsEnabled:true, duetEnabled:true, stitchEnabled:true, enabled:true }, account, channel, evidence });
  assert.equal(publicTiktok.cases.find(x=>x.testKey==="SECRET_LIVE").status, "BLOCKED");
});

test("unhealthy session blocks route matrix even if historical route tests passed", () => {
  const profile = { postingProfileId:"tt-secret", displayName:"TikTok Only You", platform:"tiktok", format:"tiktok", visibility:"only_you", commentsEnabled:true, duetEnabled:false, stitchEnabled:false, enabled:true };
  const matrix = buildRouteTestMatrix({ route, profile, account, channel:{ ...channel, sessionHealth:"AUTH_REQUIRED" }, evidence });
  assert.equal(matrix.overall, "BLOCKED");
  assert.equal(matrix.cases.find(x=>x.testKey==="SESSION").status, "FAIL");
});

test("PUBLISH_UNCERTAIN incident exposes reconciliation but never direct resume", () => {
  const view = incidentView({ incidentId:"i1", fingerprint:"f", kind:"PUBLISH_UNCERTAIN", severity:"CRITICAL", title:"Uncertain", summary:"May already exist", scope:{ intentId:"intent-1", accountId:"ig1" }, evidenceRefs:[], metadata:{}, status:"OPEN", openedAt:"2026-08-27T07:00:00.000Z", lastObservedAt:"2026-08-27T07:00:00.000Z", occurrenceCount:1 });
  assert.deepEqual(view.allowedActions, ["ACKNOWLEDGE","OPEN_RECONCILIATION"]);
  assert.match(view.prohibitedAction, /Nie Resume\/Retry/);
});

test("activity projection has deterministic newest-first ordering", () => {
  const sorted = sortActivity([
    { activityId:"a", occurredAt:"2026-08-27T07:00:00.000Z", kind:"SOURCE", title:"A", summary:"A" },
    { activityId:"b", occurredAt:"2026-08-27T08:00:00.000Z", kind:"PLAN", title:"B", summary:"B" }
  ]);
  assert.deepEqual(sorted.map(x=>x.activityId), ["b","a"]);
});

const baseAggregate = { assetId:"a", requiredDeliveryIds:["ig","tt"], optionalDeliveryIds:[], verifiedDeliveryIds:["ig"], waivedDeliveryIds:[], failedDeliveryIds:["tt"], status:"PARTIAL" };

test("Drive disposition never mutates source for partial/blocked states by default", () => {
  const policy = { mode:"move_on_complete", completedDestinationRef:"done", leavePartialUntouched:true, leaveBlockedUntouched:true };
  assert.equal(decideSourceDisposition(baseAggregate, policy).action, "NOOP");
  assert.equal(decideSourceDisposition({ ...baseAggregate, verifiedDeliveryIds:[], status:"BLOCKED" }, policy).action, "NOOP");
});

test("only COMPLETE aggregate may trigger configured metadata/sidecar/move disposition", () => {
  const complete = { ...baseAggregate, verifiedDeliveryIds:["ig","tt"], failedDeliveryIds:[], status:"COMPLETE" };
  assert.equal(decideSourceDisposition(complete, { mode:"database_only", leavePartialUntouched:true, leaveBlockedUntouched:true }).action, "RECORD_ONLY");
  assert.equal(decideSourceDisposition(complete, { mode:"drive_metadata", leavePartialUntouched:true, leaveBlockedUntouched:true }).action, "WRITE_METADATA");
  assert.equal(decideSourceDisposition(complete, { mode:"sidecar", leavePartialUntouched:true, leaveBlockedUntouched:true }).action, "WRITE_SIDECAR");
  const move = decideSourceDisposition(complete, { mode:"move_on_complete", completedDestinationRef:"done", leavePartialUntouched:true, leaveBlockedUntouched:true });
  assert.deepEqual(move, { action:"MOVE", destinationRef:"done", reason:"All required deliveries are complete and explicit move_on_complete policy is configured." });
});

test("move_on_complete without destination fails to manual review instead of guessing", () => {
  const complete = { ...baseAggregate, verifiedDeliveryIds:["ig","tt"], failedDeliveryIds:[], status:"COMPLETE" };
  assert.equal(decideSourceDisposition(complete, { mode:"move_on_complete", leavePartialUntouched:true, leaveBlockedUntouched:true }).action, "MANUAL_REVIEW");
});
