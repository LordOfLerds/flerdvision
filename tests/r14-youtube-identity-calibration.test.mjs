import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ConfiguredDomSessionProbe } from "../dist/adapters/browser/configured-dom-probe.js";

// Live calibration 2026-08-31 against the real account (@lucae-q8y): Studio's root renders no
// handle at all, and the own-channel page renders the handle to EVERY visitor. Identity
// therefore needs both — the handle on a handle-scoped URL, and the owner-only Studio link that
// proves this session owns the channel. Without the ownership proof a logged-out page would
// read the right handle and pass as HEALTHY.

function session({ handle, owner }) {
  return {
    async navigate() {},
    currentUrl: () => "https://www.youtube.com/@lucae-q8y",
    async evaluate(expression) {
      if (expression.includes("yt-content-metadata-view-model")) return handle;
      if (expression.includes("studio.youtube.com/channel/")) return owner;
      return null;
    }
  };
}

const config = {
  probeUrl: "https://www.youtube.com/@lucae-q8y",
  identitySelector: "yt-content-metadata-view-model span span",
  ownerProofSelector: 'a[href^="https://studio.youtube.com/channel/"]',
  identityTimeoutMs: 300,
  identityPollMs: 50,
  navigate: true
};

test("handle plus ownership proof is HEALTHY", async () => {
  const result = await new ConfiguredDomSessionProbe(config).probe(session({ handle: "@lucae-q8y", owner: true }));
  assert.equal(result.state, "HEALTHY");
  assert.equal(result.observedHandle, "@lucae-q8y");
});

test("the right handle without ownership proof is never HEALTHY", async () => {
  const result = await new ConfiguredDomSessionProbe(config).probe(session({ handle: "@lucae-q8y", owner: false }));
  assert.notEqual(result.state, "HEALTHY");
  assert.match(result.note ?? "", /ownership was not proven/);
});

test("the compiler and login agree on the calibrated youtube probe", () => {
  const compiler = readFileSync(new URL("../src/application/workspace-spec-compiler.ts", import.meta.url).pathname, "utf8");
  const login = readFileSync(new URL("../src/application/headless-login.ts", import.meta.url).pathname, "utf8");
  for (const source of [compiler, login]) {
    assert.match(source, /yt-content-metadata-view-model span span/);
    assert.match(source, /ownerProofSelector: 'a\[href\^="https:\/\/studio\.youtube\.com\/channel\/"\]'/);
    assert.match(source, /https:\/\/www\.youtube\.com\/@\$\{/);
  }
});

test("the navigation settle loop survives redirect chains that destroy the context", () => {
  const cdp = readFileSync(new URL("../src/adapters/browser/chromium-cdp.ts", import.meta.url).pathname, "utf8");
  const idx = cdp.indexOf("Navigation did not settle within");
  const block = cdp.slice(Math.max(0, idx - 1600), idx);
  assert.match(block, /navigated or closed\|execution context was destroyed\|cannot find context/);
  assert.match(block, /if \(!\/navigated or closed[^)]*\.test\(message\)\) throw error;/);
});
