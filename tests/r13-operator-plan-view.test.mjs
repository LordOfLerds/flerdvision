import test from "node:test";
import assert from "node:assert/strict";
import { collectOperatorPlanView, renderOperatorPlan } from "../dist/application/operator-plan-view.js";

// R13: the /plan reply and the morning checklist are the same German compact view: entries named
// after the source video file, checked off as VERIFIED, plus Drive pipeline state and disturbances.

const channels = [
  { key: "reels", name: "Reels", platform: "instagram", accountId: "account:instagram:reels" },
  { key: "clips", name: "Clips", platform: "tiktok", accountId: "account:tiktok:clips" }
];

function storedIntent(intentId, accountId, state, scheduledFor, contentId = `content:${intentId}`) {
  return {
    intent: { intentId, contentId, creatorId: "c", platform: "instagram", accountId, format: "reel", copyVersionId: "v1", scheduledFor, idempotencyKey: intentId },
    state, createdAt: scheduledFor, updatedAt: scheduledFor
  };
}

function asset(contentId, filename, state) {
  return { asset: { assetId: `asset:${contentId}`, contentId, laneId: "lane", creatorId: "c", sourceObservationId: "o", sourceRef: "r", externalObjectId: "x", filename, mediaFingerprint: "f", observedAt: "2026-08-30T05:00:00Z", state, metadata: {} }, version: 1, recordedAt: "2026-08-30T05:00:00Z" };
}

function stores(overrides = {}) {
  return {
    control: {
      listIntents: () => [
        storedIntent("i1", "account:instagram:reels", "VERIFIED", "2026-08-30T07:30:00Z"),
        storedIntent("i2", "account:tiktok:clips", "SCHEDULED", "2026-08-30T16:00:00Z"),
        storedIntent("i3", "account:instagram:reels", "PUBLISH_UNCERTAIN", "2026-08-30T12:00:00Z"),
        storedIntent("iOther", "account:instagram:reels", "SCHEDULED", "2026-08-31T07:30:00Z")
      ],
      getReservationForIntent: () => null,
      listIncidents: () => [],
      listKillSwitches: () => [],
      ...overrides.control
    },
    state: { listAssets: () => [
      asset("content:i1", "morgen-reel.mp4", "COMPLETE"),
      asset("content:i2", "abend-clip.mp4", "READY"),
      asset("content:new", "neu.mp4", "OBSERVED"),
      asset("content:bad", "kaputt.mp4", "BLOCKED")
    ], ...overrides.state },
    pauses: { listSchedulePauses: () => [], ...overrides.pauses }
  };
}

test("view collects only the business date, names entries by filename and sorts by time", () => {
  const view = collectOperatorPlanView(stores(), channels, "2026-08-30", "Europe/Vienna");
  assert.equal(view.entries.length, 3);
  assert.deepEqual(view.entries.map((entry) => entry.intentId), ["i1", "i3", "i2"]);
  assert.equal(view.entries[0].label, "morgen-reel.mp4");
  assert.equal(view.entries[0].timeLocal, "09:30");
  assert.equal(view.entries[2].channelKey, "clips");
  assert.equal(view.pipeline.observed, 1);
  assert.equal(view.pipeline.ready, 1);
  assert.equal(view.pipeline.blocked, 1);
  assert.deepEqual(view.pipeline.blockedLabels, ["kaputt.mp4"]);
});

test("render shows checkmarks, uncertainty freeze, pipeline and disturbances in German", () => {
  const view = collectOperatorPlanView(stores({
    control: {
      listIncidents: () => [{ incidentId: "inc1", fingerprint: "f", kind: "SOURCE_BLOCKED", severity: "ERROR", title: "Content source blocked", summary: "s", scope: {}, evidenceRefs: [], metadata: {}, status: "OPEN", openedAt: "2026-08-30T06:00:00Z", lastObservedAt: "2026-08-30T06:00:00Z", occurrenceCount: 1 }],
      listKillSwitches: () => [{ scopeType: "GLOBAL", scopeKey: "*", enabled: true, reason: "stop", updatedAt: "2026-08-30T06:00:00Z", updatedBy: "op" }]
    },
    pauses: { listSchedulePauses: () => [{ scopeKey: "account:tiktok:clips", channelKey: "clips", reason: "operator_pause", pausedAt: "2026-08-30T06:00:00Z", pausedBy: "op" }] }
  }), channels, "2026-08-30", "Europe/Vienna");
  const text = renderOperatorPlan(view);
  assert.match(text, /📋 Tagesplan 2026-08-30/);
  assert.match(text, /✅ 09:30 · reels · morgen-reel\.mp4/);
  assert.match(text, /🛑 14:00 · reels · content:i3 \(UNSICHER — eingefroren\)/);
  assert.match(text, /⬜ 18:00 · clips · abend-clip\.mp4/);
  assert.match(text, /📥 Drive-Pipeline: 1 neu · 0 stabilisierend · 1 READY · 1 blockiert/);
  assert.match(text, /⚠️ blockiert: kaputt\.mp4/);
  assert.match(text, /⏸️ Pausiert: clips \(operator_pause\)/);
  assert.match(text, /🛑 Kill-Switch aktiv: ALLE — Deaktivierung nur im Terminal/);
  assert.match(text, /⚠️ Störungen:/);
  assert.match(text, /🛑 Content source blocked/);
});

test("an empty day renders a clear German empty state", () => {
  const view = collectOperatorPlanView(stores({ control: { listIntents: () => [] }, state: { listAssets: () => [] } }), channels, "2026-08-30", "Europe/Vienna");
  const text = renderOperatorPlan(view);
  assert.match(text, /Keine Posts geplant\./);
  assert.match(text, /📥 Drive-Pipeline: 0 neu · 0 stabilisierend · 0 READY · 0 blockiert/);
});
