import test from "node:test";
import assert from "node:assert/strict";
import { operatorMessageSamples } from "../scripts/render-operator-messages.mjs";
import { assertOperatorSafe } from "./operator-message-safety.mjs";

// The cross-kind guarantee: one realistic example of EVERY operator message, rendered by the
// real builders against in-memory fakes, must be free of spec keys, internal ids, file paths,
// ISO timestamps and raw state words. A leak fails here instead of reaching Luca's chat.

const samples = await operatorMessageSamples();

test("every operator message kind produces text", () => {
  assert.equal(samples.length, 14);
  for (const sample of samples) assert.ok(sample.text.trim().length > 0, `${sample.kind} rendered nothing`);
});

test("no rendered kind leaks a spec key, an internal id, a path, an ISO stamp or a raw state", () => {
  for (const sample of samples) assertOperatorSafe(sample.text, sample.kind);
});

test("every message stays inside Telegram's single-message limit", () => {
  for (const sample of samples) assert.ok(sample.text.length <= 4000, `${sample.kind} is too long`);
});

test("the uncertain post is the one message that carries the verify command", () => {
  const uncertain = samples.find((sample) => sample.kind.includes("UNSICHER"));
  assert.match(uncertain.text, /Was jetzt: npm run flerdvision -- verify --run-id /);
  assert.match(uncertain.text, /eingefroren — kein automatischer Neuversuch/);
});

test("no message points at the retired control-center UI", () => {
  for (const sample of samples) assert.doesNotMatch(sample.text, /control-center/, sample.kind);
});

test("the checklist counts Drive from the store and announces the next slot", () => {
  const plan = samples.find((sample) => sample.kind.includes("Tagesplan"));
  // The numbers are the asset store's own states, said the way a person reads them.
  assert.match(plan.text, /📥 Drive: 1 Video bereit · 1 unbrauchbar/);
  assert.match(plan.text, /63 in Prüfung/);
  assert.doesNotMatch(plan.text, /beobachtet|stabilisierend/);
  assert.match(plan.text, /⏭️ Als Nächstes: \d{2}:\d{2} · /);
});

test("the evening report links what actually went live", () => {
  const evening = samples.find((sample) => sample.kind.includes("Tagesabschluss"));
  assert.match(evening.text, /Heute veröffentlicht:/);
  assert.match(evening.text, /https:\/\/www\.instagram\.com\/reel\//);
});

test("no message ever sends the operator to a terminal diagnostic", () => {
  // Luca reads these on a phone. "/doctor im Terminal" is not something he can do there, and it
  // is never the answer to a channel that is logged out or a folder that is empty.
  for (const sample of samples) assert.doesNotMatch(sample.text, /\/doctor/, sample.kind);
});

test("every message that asks for a video names the folder to put it in", () => {
  const asks = samples.filter((sample) => /Drive-Ordner/.test(sample.text));
  assert.ok(asks.length >= 2, "the pre-slot warning and the blocked-media message both ask for a video");
  for (const sample of asks) {
    assert.match(sample.text, /📁 Video hier ablegen: https:\/\/drive\.google\.com\/drive\/folders\/[A-Za-z0-9_-]+/, sample.kind);
  }
});

test("a channel that is not released yet is named in the checklist, never dropped", () => {
  const plan = samples.find((sample) => sample.kind.includes("Tagesplan"));
  // YouTube has no intents until its route is released; omitting it made a joining channel look
  // like a healthy one.
  assert.match(plan.text, /⏳ LordOfLerds Shorts \(YouTube\) · nicht freigegeben — Qualifikation fehlt/);
  assert.match(plan.text, /https:\/\/drive\.google\.com\/drive\/folders\/1ShortsFolderIdAbCd/);
});

test("failures from qualification runs never appear as operator disturbances", () => {
  // The samples carry three OPEN PUBLISH_UNCERTAIN incidents from release runs plus one real
  // blocked Drive file. Only the real one may be counted.
  for (const kind of ["Tagesplan", "/status", "Tagesabschluss"]) {
    const sample = samples.find((item) => item.kind.includes(kind));
    assert.doesNotMatch(sample.text, /Offene Störungen: [2-9]/, kind);
    assert.doesNotMatch(sample.text, /weitere Störungen/, kind);
  }
  const plan = samples.find((sample) => sample.kind.includes("Tagesplan"));
  assert.equal(plan.text.match(/Nach dem Klick ist unklar/g), null);
});

test("every checklist row has the same shape", () => {
  const plan = samples.find((sample) => sample.kind.includes("Tagesplan"));
  const rows = plan.text.split("\n").filter((line) => /^[^\s]/.test(line) && / · /.test(line) && !line.startsWith("📥"));
  const slotted = rows.filter((line) => /^\S+ \d{2}:\d{2} · /.test(line));
  assert.ok(slotted.length >= 3, `expected the day's slots as rows, got:\n${rows.join("\n")}`);
  // Continuation lines (caption, link, reason) all carry exactly one indent, never five spaces.
  for (const line of plan.text.split("\n").filter((line) => /^\s+\S/.test(line))) {
    assert.match(line, /^ {3}\S/, `ragged indent: ${JSON.stringify(line)}`);
  }
});

test("the evening report reports the day, with links and without a bare fraction", () => {
  const evening = samples.find((sample) => sample.kind.includes("Tagesabschluss"));
  assert.match(evening.text, /von \d+ geplanten Posts sind live/);
  assert.doesNotMatch(evening.text, /\d+\/\d+ verifiziert/);
});

test("the doctor keeps the release SHA but says everything else in German", () => {
  const doctor = samples.find((sample) => sample.kind.includes("doctor"));
  assert.match(doctor.text, /Release [0-9a-f]{40}/);
  assert.match(doctor.text, /Gesamt: Warnung/);
  assert.match(doctor.text, /Google-Drive-Zugang: Fehler/);
});
