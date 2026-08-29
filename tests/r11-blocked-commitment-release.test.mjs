import test from "node:test";
import assert from "node:assert/strict";
import { PersistedPlanningCommitmentAdapter } from "../dist/adapters/distribution/sqlite-planning-commitments.js";
import { RuntimeDistributionIntentMaterializerAdapter } from "../dist/application/runtime-distribution-adapters.js";

// Live finding (lordoflerds acceptance): a missed-window intent went BLOCKED, its planning
// commitment kept pinning the stale delivery into every replan of the day, and after a same-day
// schedule change every cycle ended in a provenance conflict reported only as "1 blocked" --
// reason swallowed. The commitment of a BLOCKED intent with zero publish attempts must be
// released; one with any attempt must stay pinned (it may have published; replanning could
// double-post).

const delivery = {
  deliveryId: "delivery:d1", routeId: "route:r1", assetId: "asset:a1", contentId: "content:c1",
  creatorId: "creator", laneId: "lane:l1", accountId: "acc:1", platform: "instagram",
  format: "reel", postingProfileId: "pp:1", copyProfileId: "cp:1", copyVersionId: "v1",
  schedulePolicyId: "sp:1", requirement: "REQUIRED", businessDate: "2026-08-29",
  slotKey: "s1", scheduledFor: "2026-08-29T17:00:00.000Z",
  windowStartAt: "2026-08-29T16:30:00.000Z", windowEndAt: "2026-08-29T17:30:00.000Z"
};

function adapterWith({ state, attempts }) {
  const runtime = { latestDailyPlan: () => ({ plan: { businessDate: "2026-08-29", deliveries: [delivery], gaps: [], backlog: [] } }) };
  const provenance = { getIntentByDelivery: () => ({ envelope: { intent: { intentId: "intent:i1" } } }) };
  const control = {
    getReservationForIntent: () => ({ reservationId: "reservation:i1" }),
    getIntent: () => ({ intent: { intentId: "intent:i1" }, state }),
    listPublishAttempts: () => attempts
  };
  return new PersistedPlanningCommitmentAdapter(runtime, provenance, control);
}

test("a BLOCKED intent with zero publish attempts releases its planning commitment", () => {
  const committed = adapterWith({ state: "BLOCKED", attempts: [] }).listCommitted("2026-08-29");
  assert.equal(committed.length, 0);
});

test("a BLOCKED intent with a recorded publish attempt keeps its commitment pinned", () => {
  const committed = adapterWith({ state: "BLOCKED", attempts: [{ attemptId: "attempt:1" }] }).listCommitted("2026-08-29");
  assert.equal(committed.length, 1);
  assert.equal(committed[0].intentId, "intent:i1");
});

test("a SCHEDULED intent keeps its commitment regardless of attempts", () => {
  const committed = adapterWith({ state: "SCHEDULED", attempts: [] }).listCommitted("2026-08-29");
  assert.equal(committed.length, 1);
});

// --- blocked reasons must reach the phase summary ---

test("the materializer adapter carries deduplicated blocked reasons upward", async () => {
  const inner = { ensureIntents: () => ({ created: 0, existing: 0, blocked: 2, issues: [
    { deliveryId: "d1", routeId: "r1", reason: "Intent intent:i1 already has different distribution provenance" },
    { deliveryId: "d2", routeId: "r1", reason: "Intent intent:i1 already has different distribution provenance" }
  ] }) };
  const result = await new RuntimeDistributionIntentMaterializerAdapter(inner).ensureIntents({}, "2026-08-29T20:00:00.000Z");
  assert.equal(result.blocked, 2);
  assert.deepEqual(result.blockedReasons, ["Intent intent:i1 already has different distribution provenance"]);
});

test("a clean materialization carries no reasons field", async () => {
  const inner = { ensureIntents: () => ({ created: 1, existing: 0, blocked: 0, issues: [] }) };
  const result = await new RuntimeDistributionIntentMaterializerAdapter(inner).ensureIntents({}, "2026-08-29T20:00:00.000Z");
  assert.equal("blockedReasons" in result, false);
});
