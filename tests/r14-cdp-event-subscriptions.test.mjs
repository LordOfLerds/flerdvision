import test from "node:test";
import assert from "node:assert/strict";
import { CdpClient } from "../dist/adapters/browser/chromium-cdp.js";

// The screencast is a stream: Chrome emits one Page.screencastFrame event per frame for as long
// as it runs. waitForEvent resolves once and is gone; a standing subscription is what a stream
// needs, and it must coexist with the one-shot waiters and the request/response path.

function fakeSocket() {
  const listeners = { message: [], close: [] };
  const sent = [];
  return {
    sent,
    addEventListener(type, listener) { listeners[type].push(listener); },
    send(data) { sent.push(JSON.parse(data)); },
    close() { for (const listener of listeners.close) listener({}); },
    emit(envelope) { for (const listener of listeners.message) listener({ data: JSON.stringify(envelope) }); }
  };
}

test("a subscribed handler receives every event of its method until it is removed", () => {
  const socket = fakeSocket();
  const client = CdpClient.fromSocket(socket);
  const seen = [];
  const handler = (params) => seen.push(params.sessionId);
  client.on("Page.screencastFrame", handler);
  socket.emit({ method: "Page.screencastFrame", params: { sessionId: 1, data: "a" } });
  socket.emit({ method: "Page.screencastFrame", params: { sessionId: 2, data: "b" } });
  socket.emit({ method: "Page.loadEventFired", params: {} });
  client.off("Page.screencastFrame", handler);
  socket.emit({ method: "Page.screencastFrame", params: { sessionId: 3, data: "c" } });
  assert.deepEqual(seen, [1, 2]);
});

test("a throwing handler neither blocks other handlers nor the one-shot waiter", async () => {
  const socket = fakeSocket();
  const client = CdpClient.fromSocket(socket);
  const seen = [];
  client.on("Page.screencastFrame", () => { throw new Error("bad subscriber"); });
  client.on("Page.screencastFrame", (params) => seen.push(params.sessionId));
  const waited = client.waitForEvent("Page.screencastFrame", 1000);
  socket.emit({ method: "Page.screencastFrame", params: { sessionId: 7 } });
  assert.deepEqual(await waited, { sessionId: 7 });
  assert.deepEqual(seen, [7]);
});

test("responses still resolve their own request while events flow", async () => {
  const socket = fakeSocket();
  const client = CdpClient.fromSocket(socket);
  const pending = client.send("Page.startScreencast", { format: "jpeg" }, 1000);
  assert.equal(socket.sent[0].method, "Page.startScreencast");
  socket.emit({ method: "Page.screencastFrame", params: { sessionId: 1 } });
  socket.emit({ id: socket.sent[0].id, result: {} });
  assert.deepEqual(await pending, {});
});

test("off for an unknown handler is harmless", () => {
  const client = CdpClient.fromSocket(fakeSocket());
  client.off("Page.screencastFrame", () => {});
});
