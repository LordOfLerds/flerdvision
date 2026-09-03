#!/usr/bin/env node
// Prints one realistic example of every operator message. Pure rendering against in-memory
// fakes: no network, no database, no Telegram call -- so it can be read (and diffed) whenever
// the wording changes. Run it with:  node scripts/render-operator-messages.mjs
//
// The same samples back the cross-kind safety test, so anything that leaks an id, a spec key,
// an evidence path or a raw state into a message fails the suite rather than reaching Luca.

import { publicationOutcomeMessage, publicationWaveMessage } from "../dist/application/publication-notifications.js";
import { collectOperatorPlanView, renderOperatorPlan } from "../dist/application/operator-plan-view.js";
import { notificationForAttention } from "../dist/application/attention-notifications.js";
import { IncidentNotificationService } from "../dist/application/operations.js";
import { OperatorReportService } from "../dist/application/operator-reports.js";
import { OperatorCommandService } from "../dist/application/operator-commands.js";
import { SessionHealthAlarmService } from "../dist/application/session-health-alarm.js";

const TIME_ZONE = "Europe/Vienna";
const BUSINESS_DATE = "2026-09-02";
const NOW = "2026-09-02T06:00:00.000Z";

const channels = [
  {
    key: "reels", name: "LordOfLerds Reels", platform: "instagram",
    accountId: "account:instagram:instagram-lordoflerds",
    driveFolderUrl: "https://drive.google.com/drive/folders/1ReelsFolderIdAbCdEf"
  },
  {
    key: "clips", name: "LordOfLerds Clips", platform: "tiktok",
    accountId: "account:tiktok:tiktok-lordoflerds",
    driveFolderUrl: "https://drive.google.com/drive/folders/1ClipsFolderIdAbCdEf"
  },
  // Joining, but not released yet: the checklist has to name it instead of dropping it.
  {
    key: "shorts", name: "LordOfLerds Shorts", platform: "youtube",
    accountId: "account:youtube:youtube-lordoflerds",
    driveFolderUrl: "https://drive.google.com/drive/folders/1ShortsFolderIdAbCd"
  }
];

/** What the doctor knows about each channel, mapped the way the checklist consumes it. */
const channelStatus = () => [
  { channelKey: "reels", qualified: true, readyAssets: 4 },
  { channelKey: "clips", qualified: true, readyAssets: 2 },
  { channelKey: "shorts", qualified: false, reason: "Qualifikation fehlt", readyAssets: 0 }
];

function intent(overrides = {}) {
  return {
    intentId: "intent:i1", contentId: "content:c1", creatorId: "creator:luca",
    platform: "instagram", accountId: channels[0].accountId, format: "reel",
    copyVersionId: "copy:v1", scheduledFor: "2026-09-02T07:30:00.000Z", idempotencyKey: "k1",
    ...overrides
  };
}

function storedIntent(intentId, contentId, accountId, state, scheduledFor) {
  return {
    intent: intent({ intentId, contentId, accountId, scheduledFor, platform: accountId.includes("tiktok") ? "tiktok" : "instagram" }),
    state, createdAt: scheduledFor, updatedAt: scheduledFor
  };
}

function asset(contentId, filename, state, metadata = {}) {
  return {
    asset: {
      assetId: `asset:${contentId}`, contentId, laneId: "lane:drive", creatorId: "creator:luca",
      sourceObservationId: "observation:o1", sourceRef: "gdrive://file/x", externalObjectId: "file-1",
      filename, mediaFingerprint: "fp-a", observedAt: "2026-09-02T04:00:00.000Z", state, metadata
    },
    version: 1, recordedAt: "2026-09-02T04:00:00.000Z"
  };
}

const intents = [
  storedIntent("intent:i1", "content:c1", channels[0].accountId, "VERIFIED", "2026-09-02T07:30:00.000Z"),
  storedIntent("intent:i2", "content:c2", channels[1].accountId, "SCHEDULED", "2026-09-02T16:00:00.000Z"),
  storedIntent("intent:i3", "content:c3", channels[0].accountId, "BLOCKED", "2026-09-02T10:00:00.000Z"),
  storedIntent("intent:i0", "content:c1", channels[0].accountId, "VERIFIED", "2026-08-30T07:30:00.000Z")
];

const assets = [
  asset("content:c1", "01_Sonnenuntergang am See #nature #chill.mp4", "COMPLETE"),
  asset("content:c2", "02_Abendrunde am Kanal #running.mp4", "READY"),
  asset("content:c3", "03_Kaputter Export.mp4", "BLOCKED", { blockReason: "media_probe_blocked" }),
  ...Array.from({ length: 63 }, (_value, index) => asset(`content:backlog${index}`, `Backlog ${index}.mp4`, "OBSERVED"))
];

const incident = {
  incidentId: "incident:inc1", fingerprint: "SOURCE_BLOCKED:observation:o1", kind: "SOURCE_BLOCKED", severity: "ERROR",
  title: "Content source blocked", summary: "media probe failed",
  scope: { intentId: "intent:i3", accountId: channels[0].accountId, sourceObservationId: "observation:o1" },
  evidenceRefs: ["/workspaces/ws/evidence/probe.png"],
  metadata: {}, status: "OPEN", openedAt: NOW, lastObservedAt: NOW, occurrenceCount: 1
};

// Left behind by the engineer's own release runs. It is real in the database and must never be
// counted as something the operator has to deal with.
const qualificationIncidents = [1, 2, 3].map((index) => ({
  incidentId: `incident:qual${index}`, fingerprint: `PUBLISH_UNCERTAIN:qualification:9f2a11b${index}`,
  kind: "PUBLISH_UNCERTAIN", severity: "CRITICAL", title: "Publication outcome uncertain",
  summary: `Intent qualification:9f2a11b${index} may already be published.`,
  scope: { intentId: `qualification:9f2a11b${index}`, accountId: channels[1].accountId },
  evidenceRefs: [], metadata: { owner: `headless-surface-replay:route:r2:${index}` },
  status: "OPEN", openedAt: NOW, lastObservedAt: NOW, occurrenceCount: 1
}));

const doctorReport = {
  schemaVersion: 1, checkedAt: NOW, workspaceId: "flerdvision", ownerEmail: "info@flerdvision.com",
  releaseSha: "5bd888e6bd243fef75de817b50e2440d3ec8f9c8", overall: "WARN",
  checks: [
    { key: "node", status: "PASS", detail: "node=22.9.0; required>=22" },
    { key: "drive_auth", status: "FAIL", detail: "Run drive-auth for this workspace" },
    { key: "database", status: "PASS", detail: "/workspaces/flerdvision/database/flerdvision.sqlite" }
  ],
  channels: [
    { channelKey: "reels", platform: "instagram", accountId: channels[0].accountId, identityId: "browser:b1", accountRegistered: true, identityRegistered: true, latestSessionState: "HEALTHY", sessionProbeCalibrated: true, routes: [{ routeId: "route:r1", format: "reel", readyAssets: 1, surfaceStatus: "CALIBRATED", prepareOnlyPasses: 3, verificationPassed: true, releaseMatches: true, privateE2EPassed: true, cleanupPassedAfterPrivateE2E: true, blockers: [], readyForAutonomousPublish: true }] },
    { channelKey: "clips", platform: "tiktok", accountId: channels[1].accountId, identityId: "browser:b2", accountRegistered: true, identityRegistered: true, latestSessionState: "AUTH_REQUIRED", sessionProbeCalibrated: true, routes: [{ routeId: "route:r2", format: "tiktok", readyAssets: 0, surfaceStatus: "CALIBRATED", prepareOnlyPasses: 1, verificationPassed: false, releaseMatches: true, privateE2EPassed: false, cleanupPassedAfterPrivateE2E: false, blockers: ["session_not_healthy", "no_ready_asset", "prepare_only_replays_missing"], warnings: ["private_e2e_not_run"], readyForAutonomousPublish: false }] },
    { channelKey: "shorts", platform: "youtube", accountId: channels[2].accountId, identityId: "browser:b3", accountRegistered: true, identityRegistered: true, latestSessionState: "HEALTHY", sessionProbeCalibrated: true, routes: [{ routeId: "route:r3", format: "short", readyAssets: 0, surfaceStatus: "MISSING", prepareOnlyPasses: 0, verificationPassed: false, releaseMatches: true, privateE2EPassed: false, cleanupPassedAfterPrivateE2E: false, blockers: ["route_readiness_missing", "surface_not_calibrated"], warnings: [], readyForAutonomousPublish: false }] }
  ]
};

function operatorStateFake() {
  const pauses = new Map();
  const events = new Set();
  let checklist = null;
  return {
    listSchedulePauses: () => [...pauses.values()],
    getSchedulePause: (scopeKey) => pauses.get(scopeKey) ?? null,
    setSchedulePause: (pause) => { pauses.set(pause.scopeKey, pause); return pause; },
    clearSchedulePause: (scopeKey) => pauses.delete(scopeKey),
    wasOperatorEventSent: (key) => events.has(key),
    markOperatorEventSent: (key) => { events.add(key); },
    getChecklistMessage: () => checklist,
    putChecklistMessage: (value) => { checklist = value; }
  };
}

function controlFake() {
  return {
    listIntents: () => intents,
    getReservationForIntent: () => null,
    listIncidents: () => [incident, ...qualificationIncidents],
    listKillSwitches: () => [],
    getVerifiedPublication: (intentId) => intentId === "intent:i1" ? { permalink: "https://www.instagram.com/reel/DAbC123/" } : null,
    listBrowserIdentities: () => [
      { identity: { identityId: "browser:b1", accountId: channels[0].accountId, platform: "instagram", profileKey: "instagram/reels", expectedHandle: "lordoflerds", enabled: true } },
      { identity: { identityId: "browser:b2", accountId: channels[1].accountId, platform: "tiktok", profileKey: "tiktok/clips", expectedHandle: "lordoflerds", enabled: true } }
    ],
    latestSessionHealth: (identityId) => identityId === "browser:b1"
      ? { checkId: "check-1", identityId, checkedAt: NOW, state: "HEALTHY", expectedHandle: "lordoflerds", observedHandle: "lordoflerds" }
      : { checkId: "check-2", identityId, checkedAt: NOW, state: "AUTH_REQUIRED", expectedHandle: "lordoflerds" },
  };
}

function outcome(overrides = {}) {
  return {
    intent: intent(), runId: "run:due-1", outcome: "VERIFIED", timeZone: TIME_ZONE,
    channelName: channels[0].name, videoLabel: "Sonnenuntergang am See", hashtags: "#nature #chill",
    caption: "Sonnenuntergang am See #nature #chill",
    permalink: "https://www.instagram.com/reel/DAbC123/", screenshotPath: "/workspaces/ws/evidence/post.png",
    ...overrides
  };
}

/** One realistic example of every operator message kind, as { kind, text }. */
export async function operatorMessageSamples() {
  const operatorState = operatorStateFake();
  const control = controlFake();
  const stores = { control, state: { listAssets: () => assets }, pauses: operatorState, channelStatus };

  const verified = publicationOutcomeMessage(outcome(), NOW);
  const uncertain = publicationOutcomeMessage(outcome({
    outcome: "UNCERTAIN", permalink: undefined,
    reason: "Der Klick ist passiert, die Veröffentlichung ist nicht bestätigt."
  }), NOW);
  const wave = publicationWaveMessage([
    outcome(),
    outcome({
      intent: intent({ intentId: "intent:i2", accountId: channels[1].accountId, platform: "tiktok", format: "tiktok" }),
      channelName: channels[1].name, videoLabel: "Abendrunde am Kanal", hashtags: "#running",
      caption: "Abendrunde am Kanal #running",
      permalink: "https://www.tiktok.com/@lordoflerds/video/123",
      screenshotPath: "/workspaces/ws/evidence/post-tt.png"
    })
  ], NOW, { nextSlot: { timeLocal: "18:00", channelNames: [channels[1].name] } });
  const waveWithFailure = publicationWaveMessage([
    outcome(),
    outcome({
      intent: intent({ intentId: "intent:i3", accountId: channels[1].accountId, platform: "tiktok", format: "tiktok" }),
      outcome: "UNCERTAIN", channelName: channels[1].name, permalink: undefined,
      videoLabel: "Abendrunde am Kanal", hashtags: "#running", caption: "Abendrunde am Kanal #running",
      reason: "Nach dem Klick war die Seite nicht mehr lesbar.",
      nextStep: "Nichts tun — der Post bleibt eingefroren, bis er von Hand geprüft ist."
    })
  ], NOW);

  const plan = renderOperatorPlan(collectOperatorPlanView(stores, channels, BUSINESS_DATE, TIME_ZONE, NOW), channels);

  const attention = notificationForAttention({
    attentionId: "attention:a1", severity: "ACTION_REQUIRED", kind: "SESSION_UNHEALTHY",
    title: "Session unhealthy", impact: "Für diesen Kanal wird nichts veröffentlicht.",
    accountId: channels[1].accountId, deepLink: "/control-center/channels/clips"
  }, NOW, {
    notify: { INFO: false, WARNING: true, ACTION_REQUIRED: true, CRITICAL: true },
    channels, remoteScreenUrl: "https://screen.flerdvision.invalid/vnc"
  });

  const missingContent = notificationForAttention({
    attentionId: "attention:a2", severity: "ACTION_REQUIRED", kind: "PRE_SLOT_ESCALATION",
    title: "Posting 14:00 weiterhin ohne Content", impact: "Der Slot ist in 30 Minuten fällig und weiterhin nicht belegt.",
    accountId: channels[1].accountId, slotKey: "clips-tiktok-1", slotLocalTime: "14:00", deepLink: "/routes/r2"
  }, NOW, {
    notify: { INFO: false, WARNING: true, ACTION_REQUIRED: true, CRITICAL: true },
    channels, remoteScreenUrl: "https://screen.flerdvision.invalid/vnc"
  });

  const enqueued = [];
  new IncidentNotificationService({ enqueueNotification: (message) => { enqueued.push(message); return []; } }, ["telegram"], channels)
    .enqueueNewIncident(incident, { type: "system", id: "samples" });
  const incidentMessage = enqueued[0];

  const sent = [];
  const reports = new OperatorReportService(
    { stores, channels, chatState: operatorState, messenger: { sendMessage: async (text) => { sent.push(text); return "1"; }, editMessageText: async () => {} } },
    { timeZone: TIME_ZONE }
  );
  // The day's last slot is 18:00 local (16:00Z); the evening report goes out after it.
  await reports.tick("2026-09-02T18:31:00.000Z");
  const [, dayEnd] = sent;
  // 2026-09-06 is a Sunday in Europe/Vienna, the day the weekly report goes out.
  const weeklySent = [];
  await new OperatorReportService(
    { stores, channels, chatState: operatorStateFake(), messenger: { sendMessage: async (text) => { weeklySent.push(text); return "1"; }, editMessageText: async () => {} } },
    { timeZone: TIME_ZONE }
  ).tick("2026-09-06T18:31:00.000Z");

  const commands = new OperatorCommandService({
    channels, stores, pauses: operatorState,
    killSwitches: { set: (scopeType, scopeKey, enabled, reason, at, operatorId) => ({ scopeType, scopeKey, enabled, reason, updatedAt: at, updatedBy: operatorId }) },
    doctor: () => doctorReport, timeZone: TIME_ZONE, clock: () => NOW
  });
  const status = await commands.execute("/status");
  const doctor = await commands.execute("/doctor");
  const pause = await commands.execute("/pause clips");
  const stop = await commands.execute("/stopp alle");

  const alarmSent = [];
  await new SessionHealthAlarmService({
    control, channels, pauses: operatorStateFake(), chatState: operatorStateFake(),
    messenger: { sendMessage: async (text) => { alarmSent.push(text); return "1"; } },
    remoteScreenUrl: "https://screen.flerdvision.invalid/vnc",
    clock: () => NOW
  }).tick(NOW);

  const asText = (message) => `${message.subject}\n${message.body}`;
  return [
    { kind: "1 · Post verifiziert", text: asText(verified) },
    { kind: "2 · Post UNSICHER", text: asText(uncertain) },
    { kind: "3 · Welle (alles verifiziert)", text: asText(wave) },
    { kind: "4 · Welle (mit Problem)", text: asText(waveWithFailure) },
    { kind: "5 · Tagesplan-Checkliste", text: plan },
    { kind: "6 · Aufmerksamkeit", text: asText(attention) },
    { kind: "6b · Aufmerksamkeit (Video fehlt)", text: asText(missingContent) },
    { kind: "7 · Störung", text: asText(incidentMessage) },
    { kind: "8 · Tagesabschluss", text: dayEnd },
    { kind: "9 · Wochenbericht", text: weeklySent.find((text) => text.startsWith("📅")) ?? "" },
    { kind: "10 · /status", text: status },
    { kind: "11 · /doctor", text: doctor },
    { kind: "12 · Kill-Switch / Pause", text: `${pause}\n\n${stop}` },
    { kind: "13 · Re-Login-Alarm", text: alarmSent[0] ?? "" }
  ];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const sample of await operatorMessageSamples()) {
    process.stdout.write(`\n=============== ${sample.kind}\n${sample.text}\n`);
  }
}
