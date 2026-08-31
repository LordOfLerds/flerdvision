import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// A live TikTok qualification hung with no output and no evidence for many minutes: every
// protocol call waited forever, so a browser that stopped answering could never be noticed.
// A hang is a failure, and failures must be observable.

const cdp = readFileSync(new URL("../src/adapters/browser/chromium-cdp.ts", import.meta.url).pathname, "utf8");

test("every protocol call is bounded", () => {
  assert.match(cdp, /send\(method: string, params: Readonly<Record<string, unknown>> = \{\}, timeoutMs = 90_000\)/);
  const idx = cdp.indexOf("send(method: string");
  const block = cdp.slice(idx, idx + 900);
  assert.match(block, /timed out after \$\{timeoutMs\} ms/);
});

test("the timer is cleared on both outcomes so a settled call leaves nothing behind", () => {
  const idx = cdp.indexOf("send(method: string");
  const block = cdp.slice(idx, idx + 900);
  assert.match(block, /resolve: \(value\) => \{ clearTimeout\(timer\); resolvePromise\(value\); \}/);
  assert.match(block, /reject: \(error\) => \{ clearTimeout\(timer\); reject\(error\); \}/);
});
