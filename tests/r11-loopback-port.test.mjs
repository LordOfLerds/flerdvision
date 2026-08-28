import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { loopbackPortInUse, portInUseMessage } from "../dist/application/loopback-port.js";

function listen(host) {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => res.end("busy"));
    server.listen(0, host, () => resolve({ server, port: server.address().port }));
  });
}
function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

test("a free loopback port is reported free", async () => {
  // Take a port, release it, then probe: nothing is listening any more.
  const { server, port } = await listen("127.0.0.1");
  await close(server);
  assert.equal(await loopbackPortInUse(port), false);
});

test("a port held on 127.0.0.1 is detected", async () => {
  const { server, port } = await listen("127.0.0.1");
  try {
    assert.equal(await loopbackPortInUse(port), true);
  } finally {
    await close(server);
  }
});

test("a port held on all interfaces is detected, which is the case that used to pass silently", async () => {
  // This is the real failure: binding 127.0.0.1:<port> succeeds even while another process holds
  // 0.0.0.0:<port>, so the OAuth callback could reach either listener and the run just timed out.
  const { server, port } = await listen("0.0.0.0");
  try {
    assert.equal(await loopbackPortInUse(port), true);
  } finally {
    await close(server);
  }
});

test("the refusal names the port and the flag that changes it", () => {
  const message = portInUseMessage(8765, "--port");
  assert.match(message, /8765/);
  assert.match(message, /--port/);
  // The operator must learn why a second listener is not merely untidy but silently breaking.
  assert.match(message, /split|time out/i);
});
