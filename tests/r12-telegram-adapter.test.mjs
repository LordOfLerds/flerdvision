import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TelegramNotificationAdapter, telegramAdapterFromEnv } from "../dist/adapters/notify/telegram.js";

// Telegram is Luca's chosen operator channel (decision 2026-08-30): German compact messages,
// verification screenshot as photo, permalink in the text. The adapter plugs into the durable
// outbox + retry dispatcher like every NotificationPort; credentials come from the private env
// and must never end up inside the message payloads.

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
      return {
        ok: true, status: 200,
        json: async () => payload
      };
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
