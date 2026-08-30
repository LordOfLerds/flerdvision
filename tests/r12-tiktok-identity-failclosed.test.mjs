import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { ConfiguredDomSessionProbe } from "../dist/adapters/browser/configured-dom-probe.js";

// The TikTok identity probe is deliberately UNCALIBRATED until a live snapshot of the logged-in
// TikTok shell exists. Until then two things must hold: the selector keeps its structural
// self-scoping guards (an unscoped a[href*="/@handle"] would accept a feed rendering the target
// account's videos while a different account is logged in -- the exact unsoundness the naive
// Instagram repair avoided), and every unknown outcome stays fail-closed: UNKNOWN or
// AUTH_REQUIRED, never HEALTHY.

const source = readFileSync(new URL("../src/application/headless-login.ts", import.meta.url).pathname, "utf8");

test("the TikTok selector keeps both structural self-scoping guards", () => {
  assert.match(source, /nav a\[href\*="\/@\$\{handle\}"\]/);
  assert.match(source, /a\[data-e2e\*="profile"\]\[href\*="\/@\$\{handle\}"\]/);
});

test("no unscoped TikTok anchor alternative sneaks into the selector", () => {
  // A repair that drops the guards would produce `a[href*="/@${handle}"]` standing alone in the
  // tiktok branch. The only unscoped anchor of that shape belongs to the YouTube branch.
  const tiktokLine = source.split("\n").find((line) => line.includes('=== "tiktok"') && line.includes("return `"));
  assert.ok(tiktokLine, "tiktok selector branch exists");
  for (const part of tiktokLine.split("return `")[1].split(",")) {
    assert.ok(/^\s*(?:nav |a\[data-e2e)/.test(part.trim().replace(/`;?$/, "")), `unscoped selector part: ${part.trim()}`);
  }
});

test("the calibration debt is marked at the selector", () => {
  assert.match(source, /TIKTOK-LIVE-CALIBRATION/);
});

test("the TikTok login gate waits on the platform sessionid cookie", () => {
  // Refactored into sessionCookieNames() by the youtube slice; semantics pinned, not the shape.
  assert.match(source, /if \(platform === "instagram" \|\| platform === "tiktok"\) return \["sessionid"\];/);
});

test("TikTok auth and challenge URL classification stays configured", () => {
  assert.match(source, /channel\.platform === "tiktok" \? \["\/login"\]/);
  assert.match(source, /channel\.platform === "tiktok" \? \["\/verify"\]/);
});

function tiktokProbe(overrides = {}) {
  return new ConfiguredDomSessionProbe({
    probeUrl: "https://www.tiktok.com/",
    identitySelector: 'nav a[href*="/@flerdvision"], a[data-e2e*="profile"][href*="/@flerdvision"]',
    identityAttribute: "href",
    authUrlIncludes: ["/login"],
    challengeUrlIncludes: ["/verify"],
    navigate: false,
    identityTimeoutMs: 250,
    identityPollMs: 50,
    ...overrides
  });
}

/** Minimal page double: only what ConfiguredDomSessionProbe actually calls. */
function page({ url, selectorFound }) {
  return {
    async navigate() {},
    async currentUrl() { return url; },
    async evaluate(expression) {
      if (expression.startsWith("new Promise")) return undefined;
      if (expression.startsWith("Boolean(")) return false;
      return selectorFound ? "/@flerdvision" : null;
    }
  };
}

test("a page where the selector matches nothing is UNKNOWN, never HEALTHY", async () => {
  const result = await tiktokProbe().probe(page({ url: "https://www.tiktok.com/", selectorFound: false }), {});
  assert.equal(result.state, "UNKNOWN");
  assert.equal(result.observedHandle, undefined);
});

test("a login redirect is classified AUTH_REQUIRED before any identity wait", async () => {
  const result = await tiktokProbe().probe(page({ url: "https://www.tiktok.com/login?redirect_url=%2F", selectorFound: false }), {});
  assert.equal(result.state, "AUTH_REQUIRED");
});

test("a verification challenge is classified CHALLENGE, not HEALTHY", async () => {
  const result = await tiktokProbe().probe(page({ url: "https://www.tiktok.com/verify?type=security", selectorFound: true }), {});
  assert.equal(result.state, "CHALLENGE");
});

test("a matching scoped anchor yields the handle the identity guard can normalize", async () => {
  const result = await tiktokProbe().probe(page({ url: "https://www.tiktok.com/", selectorFound: true }), {});
  assert.equal(result.state, "HEALTHY");
  assert.equal(result.observedHandle, "/@flerdvision");
});
