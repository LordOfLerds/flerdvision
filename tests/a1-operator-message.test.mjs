import test from "node:test";
import assert from "node:assert/strict";
import {
  germanDayLabel,
  operatorMessageText,
  renderOperatorMessage,
  sanitizeOperatorText
} from "../dist/application/operator-message.js";
import { assertOperatorSafe } from "./operator-message-safety.mjs";

// Slice A: every operator message is built from ONE context through ONE renderer. The renderer
// owns the vocabulary, so a caller that still holds an id, a spec key, an evidence path or a raw
// state cannot leak it into Luca's chat.

test("the sanitizer strips ids, spec keys, paths and ISO stamps and germanises raw states", () => {
  const dirty = "account:instagram:instagram-lucae71 · tiktok-lucae71 · /workspaces/ws/evidence/post.png · 2026-09-02T07:30:00.000Z · PUBLISH_UNCERTAIN";
  const clean = sanitizeOperatorText(dirty);
  assertOperatorSafe(clean, "sanitized text");
  assert.match(clean, /lucae71/);
  assert.match(clean, /unsicher, eingefroren/);
  assert.match(clean, /Mi 2\. Sep/);
});

test("a permalink survives the path filter untouched", () => {
  const link = "https://www.instagram.com/lordoflerds/reel/DAbC123/";
  assert.equal(sanitizeOperatorText(link), link);
});

test("german day labels replace the ISO business date everywhere", () => {
  assert.equal(germanDayLabel("2026-09-02"), "Mi 2. Sep");
  assert.equal(germanDayLabel("nope"), "nope");
});

test("a verified post names plan, slot, channel, video, caption and permalink", () => {
  const message = renderOperatorMessage("POST_VERIFIED", {
    planLabel: "Tagesplan Mi 2. Sep",
    slotLocal: "09:30",
    channelName: "LordOfLerds",
    platformLabel: "Instagram",
    formatLabel: "Reel",
    videoLabel: "Sonnenuntergang am See",
    caption: "Sonnenuntergang am See",
    permalink: "https://www.instagram.com/reel/ABC/",
    screenshotPath: "/evidence/post.png"
  });
  assert.match(message.subject, /✅ Post verifiziert · 09:30 · LordOfLerds \(Instagram\)/);
  assert.match(message.body, /🎬 „Sonnenuntergang am See“/);
  assert.match(message.body, /📝 Sonnenuntergang am See/);
  assert.match(message.body, /https:\/\/www\.instagram\.com\/reel\/ABC\//);
  assertOperatorSafe(operatorMessageText(message), "POST_VERIFIED");
});

test("an uncertain post says what happened and carries exactly one verify command", () => {
  const message = renderOperatorMessage("POST_UNCERTAIN", {
    planLabel: "Tagesplan Mi 2. Sep", slotLocal: "09:30", channelName: "LordOfLerds", platformLabel: "TikTok",
    videoLabel: "Sonnenuntergang am See", caption: "Sonnenuntergang am See", runId: "due:ws"
  });
  assert.match(message.subject, /🛑 Post UNSICHER/);
  assert.match(message.body, /eingefroren — kein automatischer Neuversuch/);
  assert.match(message.body, /Was jetzt: npm run flerdvision -- verify --run-id due:ws/);
  assert.equal(message.body.match(/npm run flerdvision/g).length, 1);
});

test("a wave renders one line per post, marks failures and can announce the next slot", () => {
  const message = renderOperatorMessage("WAVE", [
    { planLabel: "Tagesplan Mi 2. Sep", slotLocal: "09:30", channelName: "LordOfLerds", platformLabel: "Instagram", formatLabel: "Reel", videoLabel: "Sonnenuntergang am See", hashtags: "#nature #chill", permalink: "https://x.invalid/ig", ok: true, nextSlot: { timeLocal: "12:00", channelNames: ["LordOfLerds", "Clips"] } },
    { channelName: "Clips", platformLabel: "TikTok", formatLabel: "Video", videoLabel: "Sonnenuntergang am See", ok: false, reason: "Die Plattform hat den Upload abgelehnt.", nextStep: "Datei prüfen und in Drive ersetzen." }
  ]);
  assert.match(message.subject, /🛑 09:30-Welle · 2 Posts · 1 mit Problemen/);
  assert.match(message.body, /✅ LordOfLerds \(Instagram\) · Reel · „Sonnenuntergang am See“ · #nature #chill · https:\/\/x\.invalid\/ig/);
  assert.match(message.body, /🛑 Clips \(TikTok\)/);
  assert.match(message.body, /Was jetzt: Datei prüfen und in Drive ersetzen\./);
  assert.match(message.body, /⏭️ Als Nächstes: 12:00 · LordOfLerds, Clips/);
});

test("a wave without failures is a clean confirmation", () => {
  const message = renderOperatorMessage("WAVE", [
    { slotLocal: "09:30", channelName: "A", ok: true },
    { channelName: "B", ok: true }
  ]);
  assert.match(message.subject, /✅ 09:30-Welle · 2 Posts · verifiziert/);
});

test("the checklist carries video, caption, a known block reason and the next slot", () => {
  const message = renderOperatorMessage("PLAN", {
    planLabel: "Tagesplan Mi 2. Sep",
    entries: [
      { badge: "✅", slotLocal: "09:30", channelName: "LordOfLerds", platformLabel: "Instagram", videoLabel: "Sonnenuntergang am See", caption: "Sonnenuntergang am See", statusLabel: "verifiziert", permalink: "https://x.invalid/ig" },
      { badge: "⚠️", slotLocal: "18:00", channelName: "Clips", platformLabel: "TikTok", videoLabel: "Abendclip", statusLabel: "blockiert", reason: "Das Video lässt sich nicht lesen" }
    ],
    nextSlot: { timeLocal: "18:00", channelNames: ["Clips"] },
    sections: [{ lines: ["📥 Drive: 63 beobachtet · 1 bereit"] }]
  });
  assert.match(message.subject, /📋 Tagesplan Mi 2\. Sep/);
  assert.match(message.body, /✅ 09:30 · LordOfLerds \(Instagram\) · „Sonnenuntergang am See“ · verifiziert/);
  assert.match(message.body, /⚠️ 18:00 · Clips \(TikTok\) · „Abendclip“ · blockiert/);
  assert.match(message.body, /Das Video lässt sich nicht lesen/);
  assert.match(message.body, /63 beobachtet/);
  assert.match(message.body, /⏭️ Als Nächstes: 18:00 · Clips/);
});

test("an empty day still renders a clear German empty state", () => {
  const message = renderOperatorMessage("PLAN", { planLabel: "Tagesplan Mi 2. Sep", entries: [] });
  assert.match(message.body, /Keine Posts geplant\./);
});

test("a session-related attention offers the remote screen, otherwise the login command", () => {
  const remote = renderOperatorMessage("ATTENTION", {
    badge: "🛑", headline: "Ein Kanal ist abgemeldet", channelName: "LordOfLerds", platformLabel: "Instagram",
    reason: "Es wird nichts veröffentlicht.", remoteScreenUrl: "https://screen.invalid/vnc"
  });
  assert.match(remote.body, /Login im Remote-Browser: https:\/\/screen\.invalid\/vnc/);
  assert.doesNotMatch(operatorMessageText(remote), /\/control-center/);

  const terminal = renderOperatorMessage("ATTENTION", {
    badge: "🛑", headline: "Ein Kanal ist abgemeldet", channelName: "LordOfLerds", channelKey: "reels",
    reason: "Es wird nichts veröffentlicht."
  });
  assert.match(terminal.body, /npm run flerdvision -- login --channel reels/);
});

test("array input is sugar for entries and keeps the first element as the header", () => {
  const message = renderOperatorMessage("WAVE", [{ slotLocal: "07:15", channelName: "A", ok: true }]);
  assert.match(message.subject, /07:15-Welle · 1 Posts/);
});
