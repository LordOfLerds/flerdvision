import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { channelLoginSuccessMessage, notifyChannelLoginSuccess } from "../dist/application/headless-login.js";

// Goal C: channel number 4 can be added by someone with no chat context, and the steps show up
// in the operator chat. A HEALTHY login proven with an observed handle is the first concrete
// sign the new channel is alive -- so it, like a publication outcome, goes through the durable
// outbox to whichever adapter is configured (Telegram today). No adapter configured means no
// enqueue at all: the outbox retry loop must never be handed work it cannot ever deliver.

const channel = { key: "youtube-flerdvision", name: "Flerdvision YouTube", platform: "youtube", handle: "flerdvision", formats: [] };

test("the login message names the channel and handle and says what happens next", () => {
  const message = channelLoginSuccessMessage(channel, "flerdvision", "2026-09-03T08:00:00.000Z");
  assert.equal(message.kind, "READINESS");
  assert.equal(message.severity, "INFO");
  assert.equal(message.body, "✅ Flerdvision YouTube angemeldet als @flerdvision — bereit für die Qualifikation.");
  assert.equal(message.accountId, "account:youtube:youtube-flerdvision");
});

test("a proven login enqueues durably and dispatches immediately", async () => {
  const enqueued = [];
  const sent = [];
  const outbox = {
    enqueueNotification(message, channelKeys) { enqueued.push({ message, channelKeys }); return channelKeys.map((key) => ({ notificationId: message.notificationId, channelKey: key, status: "PENDING", attempts: 0 })); },
    listNotificationDeliveries() { return enqueued.flatMap(({ message, channelKeys }) => channelKeys.map((key) => ({ notificationId: message.notificationId, channelKey: key, status: "PENDING", attempts: 0 }))); },
    getNotification(id) { return enqueued.find(({ message }) => message.notificationId === id)?.message ?? null; },
    markNotificationSent(id, key) { sent.push({ id, key }); },
    markNotificationFailed() {}
  };
  const adapter = { channelKey: "telegram", async send() { return { externalMessageId: "9" }; } };
  await notifyChannelLoginSuccess(outbox, [adapter], channel, "flerdvision", "2026-09-03T08:00:00.000Z", { type: "operator", id: "headless-login" });
  assert.equal(enqueued.length, 1);
  assert.deepEqual(enqueued[0].channelKeys, ["telegram"]);
  assert.match(enqueued[0].message.body, /^✅ Flerdvision YouTube angemeldet als @flerdvision/);
  assert.equal(sent.length, 1);
});

test("no configured adapter means no enqueue at all", async () => {
  let called = false;
  const outbox = { enqueueNotification() { called = true; return []; } };
  await notifyChannelLoginSuccess(outbox, [], channel, "flerdvision", "2026-09-03T08:00:00.000Z", { type: "operator", id: "headless-login" });
  assert.equal(called, false);
});

test("a broken adapter is swallowed; a proven login must never fail because a message could not send", async () => {
  const outbox = {
    enqueueNotification(message, channelKeys) { return channelKeys.map((key) => ({ notificationId: message.notificationId, channelKey: key, status: "PENDING", attempts: 0 })); },
    listNotificationDeliveries() { return [{ notificationId: "x", channelKey: "telegram", status: "PENDING", attempts: 0 }]; },
    getNotification() { return channelLoginSuccessMessage(channel, "flerdvision", "2026-09-03T08:00:00.000Z"); },
    markNotificationSent() {},
    markNotificationFailed() {}
  };
  const explosive = { channelKey: "telegram", async send() { throw new Error("boom"); } };
  await assert.doesNotReject(notifyChannelLoginSuccess(outbox, [explosive], channel, "flerdvision", "2026-09-03T08:00:00.000Z", { type: "operator", id: "headless-login" }));
});

test("ensureHeadlessLogin notifies through the existing Telegram outbox wiring exactly on the HEALTHY branch", () => {
  const source = readFileSync(new URL("../src/application/headless-login.ts", import.meta.url).pathname, "utf8");
  assert.match(source, /telegramAdapterFromEnv\(env\)/);
  const healthy = source.indexOf('if (check.state === "HEALTHY") {');
  const returnIdx = source.indexOf("return { channelKey: channel.key", healthy);
  const block = source.slice(healthy, returnIdx);
  assert.match(block, /notifyChannelLoginSuccess\(control, adapters \? \[adapters\] : \[\], channel, proven\.observedHandle, checkedAt/);
});
