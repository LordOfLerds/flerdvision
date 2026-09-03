import test from "node:test";
import assert from "node:assert/strict";
import { collectOperatorPlanView, renderOperatorPlan } from "../dist/application/operator-plan-view.js";

// R13: the /plan reply and the morning checklist are the same German compact view: entries named
// after the source video file, checked off as VERIFIED, plus Drive pipeline state and disturbances.

const channels = [
  { key: "reels", name: "Reels", platform: "instagram", accountId: "account:instagram:reels" },
  {
    key: "clips", name: "Clips", platform: "tiktok", accountId: "account:tiktok:clips",
    driveFolderUrl: "https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrS"
  }
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
  assert.deepEqual(view.pipeline.blockedAssets, [{ label: "kaputt" }]);
});

test("render shows checkmarks, uncertainty freeze, pipeline and disturbances in German", () => {
  const view = collectOperatorPlanView(stores({
    control: {
      listIncidents: () => [{ incidentId: "inc1", fingerprint: "f", kind: "SOURCE_BLOCKED", severity: "ERROR", title: "Content source blocked", summary: "s", scope: { sourceObservationId: "observation:o1" }, evidenceRefs: [], metadata: {}, status: "OPEN", openedAt: "2026-08-30T06:00:00Z", lastObservedAt: "2026-08-30T06:00:00Z", occurrenceCount: 1 }],
      listKillSwitches: () => [{ scopeType: "GLOBAL", scopeKey: "*", enabled: true, reason: "stop", updatedAt: "2026-08-30T06:00:00Z", updatedBy: "op" }]
    },
    pauses: { listSchedulePauses: () => [{ scopeKey: "account:tiktok:clips", channelKey: "clips", reason: "operator_pause", pausedAt: "2026-08-30T06:00:00Z", pausedBy: "op" }] }
  }), channels, "2026-08-30", "Europe/Vienna");
  const text = renderOperatorPlan(view, channels);
  assert.match(text, /📋 Tagesplan So 30\. Aug/);
  // Names and platform, not spec keys: the operator reads "Reels (Instagram)", not "reels".
  assert.match(text, /✅ 09:30 · Reels \(Instagram\) · „morgen-reel“/);
  assert.match(text, /🛑 14:00 · Reels \(Instagram\) · „Video unbekannt“ · unsicher, eingefroren \(verify im Terminal\)/);
  assert.match(text, /⬜ 18:00 · Clips \(TikTok\) · „abend-clip“/);
  // Counts come from the asset store and are phrased for a person, not for the pipeline.
  assert.match(text, /📥 Drive: 1 Video bereit · 1 unbrauchbar \(„kaputt“\) · 1 in Prüfung/);
  assert.match(text, /⏸️ Pausiert: Clips/);
  assert.match(text, /🛑 Kill-Switch aktiv: ALLE Kanäle — Deaktivierung nur im Terminal/);
  assert.match(text, /⚠️ Störungen:/);
  assert.match(text, /🛑 Eine Datei aus Drive lässt sich nicht verwenden/);
});

test("an empty day renders a clear German empty state", () => {
  const view = collectOperatorPlanView(stores({ control: { listIntents: () => [] }, state: { listAssets: () => [] } }), channels, "2026-08-30", "Europe/Vienna");
  const text = renderOperatorPlan(view);
  assert.match(text, /Heute ist kein Post geplant\./);
  assert.match(text, /📥 Drive: 0 Videos bereit · 0 unbrauchbar · 0 in Prüfung/);
  // Every configured channel is still named, even on a day with nothing to do.
  assert.match(text, /➖ Reels \(Instagram\) · heute kein Post geplant/);
  assert.match(text, /➖ Clips \(TikTok\) · heute kein Post geplant/);
});

test("a channel whose route is not released appears with the reason and its Drive folder", () => {
  const view = collectOperatorPlanView({
    ...stores({ control: { listIntents: () => [] } }),
    channelStatus: () => [
      { channelKey: "reels", qualified: true, readyAssets: 3 },
      { channelKey: "clips", qualified: false, reason: "Qualifikation fehlt", readyAssets: 0 }
    ]
  }, channels, "2026-08-30", "Europe/Vienna");
  assert.deepEqual(view.channelGaps.map((gap) => gap.channelKey), ["reels", "clips"]);
  const text = renderOperatorPlan(view, channels);
  assert.match(text, /⏳ Clips \(TikTok\) · nicht freigegeben — Qualifikation fehlt/);
  assert.match(text, /https:\/\/drive\.google\.com\/drive\/folders\/1AbCdEfGhIjKlMnOpQrS/);
});

test("a released channel without a ready video says exactly that", () => {
  const view = collectOperatorPlanView({
    ...stores({ control: { listIntents: () => [] } }),
    channelStatus: () => [{ channelKey: "clips", qualified: true, readyAssets: 0 }]
  }, channels, "2026-08-30", "Europe/Vienna");
  assert.match(renderOperatorPlan(view, channels), /⚠️ Clips \(TikTok\) · kein Video im Drive-Ordner/);
});

test("a qualification run's own failures never reach the operator's disturbance list", () => {
  const qualification = (incidentId, intentId) => ({
    incidentId, fingerprint: `PUBLISH_UNCERTAIN:${intentId}`, kind: "PUBLISH_UNCERTAIN", severity: "CRITICAL",
    title: "Publication outcome uncertain", summary: `Intent ${intentId} may already be published.`,
    scope: { intentId, accountId: "account:instagram:reels" }, evidenceRefs: [], metadata: {},
    status: "OPEN", openedAt: "2026-08-30T06:00:00Z", lastObservedAt: "2026-08-30T06:00:00Z", occurrenceCount: 1
  });
  const view = collectOperatorPlanView(stores({
    control: {
      listIncidents: () => [
        qualification("inc-q1", "qualification:9f2a11bc"),
        qualification("inc-q2", "qualification:0011aabb"),
        { ...qualification("inc-real", "i3"), fingerprint: "PUBLISH_UNCERTAIN:i3", summary: "Intent i3 may already be published." },
        { ...qualification("inc-yesterday", "iYesterday"), fingerprint: "PUBLISH_UNCERTAIN:iYesterday", summary: "Intent iYesterday may already be published." },
        { ...qualification("inc-acked", "i1"), fingerprint: "PUBLISH_UNCERTAIN:i1", summary: "Intent i1 may already be published.", status: "ACKNOWLEDGED" }
      ]
    }
  }), channels, "2026-08-30", "Europe/Vienna");
  // Only the OPEN incident on one of today's own intents survives.
  assert.deepEqual(view.disturbances.map((incident) => incident.incidentId), ["inc-real"]);
});

test("a verified entry carries the live post link, an unverified one carries none", () => {
  const withLink = collectOperatorPlanView(stores({
    control: { getVerifiedPublication: (intentId) => intentId === "i1" ? { permalink: "https://www.instagram.com/reel/ABC/" } : null }
  }), channels, "2026-08-30", "Europe/Vienna");
  const verified = withLink.entries.find((entry) => entry.state === "VERIFIED");
  assert.equal(verified.permalink, "https://www.instagram.com/reel/ABC/");
  const text = renderOperatorPlan(withLink);
  // A checklist that goes green without a link says nothing the operator can act on.
  assert.match(text, /https:\/\/www\.instagram\.com\/reel\/ABC\//);
  const pending = withLink.entries.find((entry) => entry.state !== "VERIFIED");
  assert.equal(pending.permalink, undefined);
});
