import test from "node:test";
import assert from "node:assert/strict";
import { TelegramCommandLoop } from "../dist/adapters/notify/telegram-command-loop.js";
import { TelegramChatMessenger } from "../dist/adapters/notify/telegram-messenger.js";

// R13: the interactive loop long-polls getUpdates with an injected fetch, answers ONLY the
// configured operator chat, drops stale backlog after restarts, and never leaks the bot token
// into log lines. All network is faked -- no real Telegram call ever happens in tests.

const NOW = "2026-08-30T07:00:00.000Z";
const nowSeconds = Math.floor(new Date(NOW).getTime() / 1000);

function fakeTelegram(updatesQueue) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : {};
    calls.push({ url, body });
    if (url.endsWith("/getUpdates")) {
      const result = updatesQueue.shift() ?? [];
      return { ok: true, status: 200, json: async () => ({ ok: true, result }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 900 + calls.length } }) };
  };
  return { calls, fetchImpl };
}

function message(updateId, chatId, text, date = nowSeconds) {
  return { update_id: updateId, message: { message_id: updateId, date, text, chat: { id: chatId } } };
}

test("handles commands from the allowlisted chat and replies into the same chat", async () => {
  const { calls, fetchImpl } = fakeTelegram([[message(1, 777, "/status")]]);
  const executed = [];
  const loop = new TelegramCommandLoop({
    botToken: "tok", chatId: "777", clock: () => NOW, fetchImpl,
    execute: async (text) => { executed.push(text); return "📊 Status OK"; }
  });
  const report = await loop.pollOnce();
  assert.deepEqual(report, { handled: 1, ignored: 0, stale: 0, errors: 0 });
  assert.deepEqual(executed, ["/status"]);
  const reply = calls.find((call) => call.url.endsWith("/sendMessage"));
  assert.equal(reply.body.chat_id, "777");
  assert.equal(reply.body.text, "📊 Status OK");
});

test("foreign chats are ignored and logged, never executed, never answered", async () => {
  const { calls, fetchImpl } = fakeTelegram([[message(5, 666, "/stopp alle"), message(6, "999", "/status")]]);
  const logs = [];
  let executions = 0;
  const loop = new TelegramCommandLoop({
    botToken: "secret-token", chatId: "777", clock: () => NOW, fetchImpl, log: (line) => logs.push(line),
    execute: async () => { executions += 1; return "x"; }
  });
  const report = await loop.pollOnce();
  assert.deepEqual(report, { handled: 0, ignored: 2, stale: 0, errors: 0 });
  assert.equal(executions, 0);
  assert.equal(calls.filter((call) => call.url.endsWith("/sendMessage")).length, 0);
  assert.equal(logs.length, 2);
  assert.match(logs[0], /foreign chat 666 ignored/);
  for (const line of logs) assert.doesNotMatch(line, /secret-token/);
});

test("stale backlog after a restart is dropped instead of replayed", async () => {
  const { calls, fetchImpl } = fakeTelegram([[message(10, 777, "/stopp alle", nowSeconds - 3600), message(11, 777, "/plan", nowSeconds - 10)]]);
  const loop = new TelegramCommandLoop({
    botToken: "tok", chatId: "777", clock: () => NOW, fetchImpl,
    execute: async (text) => `ok:${text}`
  });
  const report = await loop.pollOnce();
  assert.equal(report.stale, 1);
  assert.equal(report.handled, 1);
  const replies = calls.filter((call) => call.url.endsWith("/sendMessage"));
  assert.equal(replies.length, 1);
  assert.equal(replies[0].body.text, "ok:/plan");
});

test("offset advances across polls so updates are confirmed exactly once", async () => {
  const { calls, fetchImpl } = fakeTelegram([[message(41, 777, "/plan")], []]);
  const loop = new TelegramCommandLoop({ botToken: "tok", chatId: "777", clock: () => NOW, fetchImpl, execute: async () => "ok" });
  await loop.pollOnce();
  await loop.pollOnce();
  const polls = calls.filter((call) => call.url.endsWith("/getUpdates"));
  assert.equal(polls[0].body.offset, undefined);
  assert.equal(polls[1].body.offset, 42);
  assert.deepEqual(polls[1].body.allowed_updates, ["message"]);
});

test("execute errors become a German error reply; API errors surface as report errors", async () => {
  const { calls, fetchImpl } = fakeTelegram([[message(50, 777, "/doctor")]]);
  const loop = new TelegramCommandLoop({
    botToken: "tok", chatId: "777", clock: () => NOW, fetchImpl,
    execute: async () => { throw new Error("kaputt"); }
  });
  const report = await loop.pollOnce();
  assert.equal(report.handled, 1);
  assert.match(calls.find((call) => call.url.endsWith("/sendMessage")).body.text, /🛑 Befehl fehlgeschlagen: kaputt/);

  const failing = new TelegramCommandLoop({
    botToken: "tok", chatId: "777", clock: () => NOW,
    fetchImpl: async () => ({ ok: false, status: 502, json: async () => ({ ok: false, description: "bad gateway" }) }),
    execute: async () => "ok",
    log: () => {}
  });
  const failedReport = await failing.pollOnce();
  assert.deepEqual(failedReport, { handled: 0, ignored: 0, stale: 0, errors: 1 });
});

test("run() stops on abort and backs off after errors using the injected sleep", async () => {
  let polls = 0;
  const sleeps = [];
  const signal = { aborted: false };
  const loop = new TelegramCommandLoop({
    botToken: "tok", chatId: "777", clock: () => NOW,
    fetchImpl: async () => { polls += 1; if (polls >= 3) signal.aborted = true; return { ok: false, status: 500, json: async () => ({ ok: false }) }; },
    execute: async () => "ok",
    sleep: async (ms) => { sleeps.push(ms); },
    errorBackoffMs: 1234,
    log: () => {}
  });
  await loop.run(signal);
  assert.equal(polls, 3);
  assert.deepEqual(sleeps, [1234, 1234]);
});

test("messenger sends and edits checklist messages and tolerates 'message is not modified'", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    if (url.endsWith("/editMessageText") && calls.length === 3) return { ok: false, status: 400, json: async () => ({ ok: false, description: "Bad Request: message is not modified" }) };
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 321 } }) };
  };
  const messenger = new TelegramChatMessenger({ botToken: "tok", chatId: "777", fetchImpl });
  const messageId = await messenger.sendMessage("📋 Tagesplan");
  assert.equal(messageId, "321");
  await messenger.editMessageText(messageId, "📋 Tagesplan ✅");
  assert.equal(calls[1].body.message_id, 321);
  assert.equal(calls[1].body.chat_id, "777");
  await messenger.editMessageText(messageId, "📋 Tagesplan ✅");
  await assert.rejects(async () => {
    const broken = new TelegramChatMessenger({ botToken: "tok", chatId: "777", fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({ ok: false, description: "forbidden" }) }) });
    await broken.sendMessage("x");
  }, /403.*forbidden/);
});
