import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { publicationOutcomeMessage, notifyPublicationOutcome } from "../dist/application/publication-notifications.js";

// Luca's operator channel: every post-boundary outcome reaches Telegram — VERIFIED with
// permalink + verification screenshot, UNCERTAIN as an error naming the freeze. Delivery is
// durable (outbox first, immediate dispatch attempt), and a broken channel must never break
// the verification path that reports through it.

const intent = {
  intentId: "intent:i1", contentId: "c", creatorId: "cr", platform: "instagram",
  accountId: "account:instagram:instagram-lordoflerds", format: "reel",
  copyVersionId: "v", scheduledFor: "2026-08-30T14:35:00.000Z", idempotencyKey: "k"
};

test("a verified outcome carries permalink, screenshot path and the bare handle", () => {
  const message = publicationOutcomeMessage({
    intent, runId: "run-1", outcome: "VERIFIED",
    permalink: "https://www.instagram.com/lordoflerds/reel/x/",
    screenshotPath: "/evidence/post.png"
  }, "2026-08-30T20:00:00.000Z");
  assert.equal(message.severity, "INFO");
  assert.match(message.subject, /Post verifiziert · lordoflerds/);
  assert.equal(message.metadata.permalink, "https://www.instagram.com/lordoflerds/reel/x/");
  assert.equal(message.metadata.screenshotPath, "/evidence/post.png");
});

test("an uncertain outcome is an ERROR that names the freeze and never claims success", () => {
  const message = publicationOutcomeMessage({ intent, runId: "run-1", outcome: "UNCERTAIN" }, "2026-08-30T20:00:00.000Z");
  assert.equal(message.severity, "ERROR");
  assert.match(message.subject, /UNSICHER/);
  assert.match(message.body, /eingefroren/);
  assert.match(message.body, /kein automatischer Neuversuch/);
});

test("notify enqueues durably, dispatches immediately, and swallows channel failures", async () => {
  const enqueued = [];
  const sent = [];
  const outbox = {
    enqueueNotification(message, channelKeys) { enqueued.push({ message, channelKeys }); return channelKeys.map((key) => ({ notificationId: message.notificationId, channelKey: key, status: "PENDING", attempts: 0 })); },
    listNotificationDeliveries() { return enqueued.flatMap(({ message, channelKeys }) => channelKeys.map((key) => ({ notificationId: message.notificationId, channelKey: key, status: "PENDING", attempts: 0 }))); },
    getNotification(id) { return enqueued.find(({ message }) => message.notificationId === id)?.message ?? null; },
    markNotificationSent(id, key) { sent.push({ id, key }); },
    markNotificationFailed() {}
  };
  const adapter = { channelKey: "telegram", async send(message) { return { externalMessageId: "7" }; } };
  await notifyPublicationOutcome(outbox, [adapter], { intent, runId: "r", outcome: "VERIFIED" }, "2026-08-30T20:00:00.000Z", { type: "system", id: "test" });
  assert.equal(enqueued.length, 1);
  assert.deepEqual(enqueued[0].channelKeys, ["telegram"]);
  assert.equal(sent.length, 1);

  const explosive = { channelKey: "telegram", async send() { throw new Error("boom"); } };
  await notifyPublicationOutcome(outbox, [explosive], { intent, runId: "r", outcome: "UNCERTAIN" }, "2026-08-30T20:01:00.000Z", { type: "system", id: "test" });
});

test("no configured adapter means no enqueue at all", async () => {
  let called = false;
  const outbox = { enqueueNotification() { called = true; return []; } };
  await notifyPublicationOutcome(outbox, [], { intent, runId: "r", outcome: "VERIFIED" }, "2026-08-30T20:00:00.000Z", { type: "system", id: "test" });
  assert.equal(called, false);
});

test("the private-e2e verify path reports the outcome with permalink and screenshot evidence", () => {
  const source = readFileSync(new URL("../src/adapters/runtime/workspace-private-e2e.ts", import.meta.url).pathname, "utf8");
  const idx = source.indexOf("async verify(");
  const block = source.slice(idx, idx + 1600);
  assert.match(block, /notifyPublicationOutcome/);
  assert.match(block, /screenshotPath:evidence\.artifactRef/);
  assert.match(block, /outcome:passed\?"VERIFIED":"UNCERTAIN"/);
});

test("the autonomous due path reports outcomes through the same channel", () => {
  const due = readFileSync(new URL("../src/adapters/runtime/authorized-due-execution.ts", import.meta.url).pathname, "utf8");
  assert.match(due, /notifyOutcome\(claim\.record\.intent,attempt\.attemptId,"VERIFIED"/);
  assert.match(due, /notifyOutcome\(claim\.record\.intent,attempt\.attemptId,"UNCERTAIN"/);
  const runtime = readFileSync(new URL("../src/application/headless-autonomous-runtime.ts", import.meta.url).pathname, "utf8");
  assert.match(runtime, /notificationAdapters: \[\.\.\.\(telegramAdapterFromEnv\(env\)/);
});
