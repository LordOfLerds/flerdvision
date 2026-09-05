import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TelegramNotificationAdapter, telegramAdapterFromEnv } from "../dist/adapters/notify/telegram.js";

function message(extra = {}) {
  return {
    notificationId: "n1", dedupeKey: "d1", kind: "TEST", severity: "WARNING",
    createdAt: "2026-08-30T20:00:00.000Z", subject: "Post verifiziert",
    body: "Reel wurde verifiziert.", metadata: {}, ...extra
  };
}

function capturingFetch(responses) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      const payload = responses.shift() ?? { ok: true, result: { message_id: 42 } };
      return { ok: true, status: 200, json: async () => payload };
    }
  };
}

test("plain messages go out as sendMessage with severity badge and permalink", async () => {
  const { calls, fetchImpl } = capturingFetch([]);
  const adapter = new TelegramNotificationAdapter({ channelKey: "telegram", botToken: "tok", chatId: "123", fetchImpl });
  const receipt = await adapter.send(message({ metadata: { permalink: "https://example.invalid/reel/x" } }));
  assert.equal(receipt.externalMessageId, "42");
  assert.match(calls[0].url, /api\.telegram\.org\/bottok\/sendMessage/);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.chat_id, "123");
  assert.match(body.text, /⚠️ Post verifiziert/);
  assert.match(body.text, /https:\/\/example\.invalid\/reel\/x/);
});

test("a message carrying a local screenshot goes out as sendPhoto with caption", async () => {
  const dir = mkdtempSync(join(tmpdir(), "flerdvision-tg-"));
  const shot = join(dir, "evidence.png");
  writeFileSync(shot, "png-bytes");
  try {
    const { calls, fetchImpl } = capturingFetch([]);
    const adapter = new TelegramNotificationAdapter({ channelKey: "telegram", botToken: "tok", chatId: "123", fetchImpl });
    await adapter.send(message({ metadata: { screenshotPath: shot } }));
    assert.match(calls[0].url, /sendPhoto/);
    assert.ok(calls[0].init.body instanceof FormData);
    assert.equal(calls[0].init.body.get("chat_id"), "123");
    assert.ok(calls[0].init.body.get("photo"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a screenshot wins over a run video when both are present", async () => {
  const dir = mkdtempSync(join(tmpdir(), "flerdvision-tg-shot-first-"));
  const shot = join(dir, "evidence.png");
  const video = join(dir, "run.mp4");
  writeFileSync(shot, "png-bytes");
  writeFileSync(video, "mp4-bytes");
  try {
    const { calls, fetchImpl } = capturingFetch([]);
    const adapter = new TelegramNotificationAdapter({ channelKey: "telegram", botToken: "tok", chatId: "123", fetchImpl });
    await adapter.send(message({ metadata: { screenshotPath: shot, videoPath: video } }));
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /sendPhoto/);
    assert.doesNotMatch(calls[0].url, /sendVideo/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("lifecycle metadata edits the existing text or photo caption instead of sending again", async () => {
  const textTransport = capturingFetch([]);
  const textAdapter = new TelegramNotificationAdapter({ channelKey: "telegram", botToken: "tok", chatId: "123", fetchImpl: textTransport.fetchImpl });
  const textReceipt = await textAdapter.send(message({ metadata: { editExternalMessageId: "77", editMode: "text" } }));
  assert.equal(textReceipt.externalMessageId, "42");
  assert.match(textTransport.calls[0].url, /editMessageText/);
  assert.equal(JSON.parse(textTransport.calls[0].init.body).message_id, 77);

  const captionTransport = capturingFetch([{ ok: true, result: true }]);
  const captionAdapter = new TelegramNotificationAdapter({ channelKey: "telegram", botToken: "tok", chatId: "123", fetchImpl: captionTransport.fetchImpl });
  const captionReceipt = await captionAdapter.send(message({ metadata: { editExternalMessageId: "88", editMode: "caption" } }));
  assert.equal(captionReceipt.externalMessageId, "88");
  assert.match(captionTransport.calls[0].url, /editMessageCaption/);
  assert.equal(JSON.parse(captionTransport.calls[0].init.body).message_id, 88);
});

test("a repeated lifecycle edit tolerates Telegram's message-is-not-modified response", async () => {
  const fetchImpl = async () => ({ ok: false, status: 400, json: async () => ({ ok: false, description: "Bad Request: message is not modified" }) });
  const adapter = new TelegramNotificationAdapter({ channelKey: "telegram", botToken: "tok", chatId: "123", fetchImpl });
  const receipt = await adapter.send(message({ metadata: { editExternalMessageId: "91", editMode: "text" } }));
  assert.equal(receipt.externalMessageId, "91");
});

test("a telegram API error surfaces as a throw so the outbox retries", async () => {
  const fetchImpl = async () => ({ ok: false, status: 403, json: async () => ({ ok: false, description: "bot was blocked" }) });
  const adapter = new TelegramNotificationAdapter({ channelKey: "telegram", botToken: "tok", chatId: "123", fetchImpl });
  await assert.rejects(() => adapter.send(message()), /403.*bot was blocked/);
});

test("env factory yields no adapter without both credentials, and never partial", () => {
  assert.equal(telegramAdapterFromEnv({}), undefined);
  assert.equal(telegramAdapterFromEnv({ FLERDVISION_TELEGRAM_BOT_TOKEN: "t" }), undefined);
  assert.equal(telegramAdapterFromEnv({ FLERDVISION_TELEGRAM_CHAT_ID: "c" }), undefined);
  const adapter = telegramAdapterFromEnv({ FLERDVISION_TELEGRAM_BOT_TOKEN: "t", FLERDVISION_TELEGRAM_CHAT_ID: "c" });
  assert.equal(adapter?.channelKey, "telegram");
});

test("the runtime wires telegram alongside the webhook into one dispatcher", async () => {
  const { readFileSync } = await import("node:fs");
  const runtime = readFileSync(new URL("../src/adapters/runtime/workspace-distribution-runtime.ts", import.meta.url).pathname, "utf8");
  assert.match(runtime, /telegramAdapterFromEnv\(env\)/);
  assert.match(runtime, /notificationAdapters=\[\.\.\.\(webhook\?\[webhook\]:\[\]\),\.\.\.\(telegram\?\[telegram\]:\[\]\)\]/);
});

test("a wave with several screenshots goes out as one album with the caption on the first item", async () => {
  const dir = mkdtempSync(join(tmpdir(), "flerdvision-tg-group-"));
  const shots = ["a.png", "b.png", "c.png"].map((name) => join(dir, name));
  for (const shot of shots) writeFileSync(shot, "png-bytes");
  try {
    const { calls, fetchImpl } = capturingFetch([{ ok: true, result: [{ message_id: 7 }, { message_id: 8 }] }]);
    const adapter = new TelegramNotificationAdapter({ channelKey: "telegram", botToken: "tok", chatId: "123", fetchImpl });
    const receipt = await adapter.send(message({ metadata: { screenshotPaths: shots } }));
    assert.equal(receipt.externalMessageId, "7");
    assert.match(calls[0].url, /sendMediaGroup/);
    const media = JSON.parse(calls[0].init.body.get("media"));
    assert.equal(media.length, 3);
    assert.ok(media[0].caption);
    assert.equal(media[1].caption, undefined);
    assert.ok(calls[0].init.body.get("photo2"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an album never exceeds ten photos and a long caption follows as its own message", async () => {
  const dir = mkdtempSync(join(tmpdir(), "flerdvision-tg-cap-"));
  const shots = Array.from({ length: 12 }, (_value, index) => join(dir, `s${index}.png`));
  for (const shot of shots) writeFileSync(shot, "png-bytes");
  try {
    const { calls, fetchImpl } = capturingFetch([{ ok: true, result: [{ message_id: 1 }] }]);
    const adapter = new TelegramNotificationAdapter({ channelKey: "telegram", botToken: "tok", chatId: "123", fetchImpl });
    await adapter.send(message({ body: "x".repeat(2000), metadata: { screenshotPaths: shots } }));
    const media = JSON.parse(calls[0].init.body.get("media"));
    assert.equal(media.length, 10);
    assert.ok(media[0].caption.length <= 1024);
    assert.match(calls[1].url, /sendMessage/);
    const follow = JSON.parse(calls[1].init.body).text;
    assert.ok(follow.length > 1024 && follow.length <= 4000);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a small local video goes out as sendVideo, an oversized one falls back to text", async () => {
  const dir = mkdtempSync(join(tmpdir(), "flerdvision-tg-video-"));
  const small = join(dir, "clip.mp4");
  const huge = join(dir, "huge.mp4");
  writeFileSync(small, "mp4-bytes");
  writeFileSync(huge, Buffer.alloc(50 * 1024 * 1024 + 1));
  try {
    const first = capturingFetch([]);
    const adapter = new TelegramNotificationAdapter({ channelKey: "telegram", botToken: "tok", chatId: "123", fetchImpl: first.fetchImpl });
    await adapter.send(message({ metadata: { videoPath: small } }));
    assert.match(first.calls[0].url, /sendVideo/);
    assert.ok(first.calls[0].init.body.get("video"));

    const second = capturingFetch([]);
    const fallback = new TelegramNotificationAdapter({ channelKey: "telegram", botToken: "tok", chatId: "123", fetchImpl: second.fetchImpl });
    await fallback.send(message({ metadata: { videoPath: huge } }));
    assert.match(second.calls[0].url, /sendMessage/);

    const third = capturingFetch([]);
    const missing = new TelegramNotificationAdapter({ channelKey: "telegram", botToken: "tok", chatId: "123", fetchImpl: third.fetchImpl });
    await missing.send(message({ metadata: { videoPath: join(dir, "gone.mp4") } }));
    assert.match(third.calls[0].url, /sendMessage/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
