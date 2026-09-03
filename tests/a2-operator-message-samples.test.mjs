import test from "node:test";
import assert from "node:assert/strict";
import { operatorMessageSamples } from "../scripts/render-operator-messages.mjs";
import { assertOperatorSafe } from "./operator-message-safety.mjs";

// The cross-kind guarantee: one realistic example of EVERY operator message, rendered by the
// real builders against in-memory fakes, must be free of spec keys, internal ids, file paths,
// ISO timestamps and raw state words. A leak fails here instead of reaching Luca's chat.

const samples = await operatorMessageSamples();

test("every operator message kind produces text", () => {
  assert.equal(samples.length, 13);
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

test("the doctor keeps the release SHA but says everything else in German", () => {
  const doctor = samples.find((sample) => sample.kind.includes("doctor"));
  assert.match(doctor.text, /Release [0-9a-f]{40}/);
  assert.match(doctor.text, /Gesamt: Warnung/);
  assert.match(doctor.text, /Google-Drive-Zugang: Fehler/);
});
