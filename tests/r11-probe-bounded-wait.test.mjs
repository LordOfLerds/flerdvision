import test from "node:test";
import assert from "node:assert/strict";

import { ConfiguredDomSessionProbe } from "../dist/adapters/browser/configured-dom-probe.js";

// A single look after a fixed settle is a race against the platform's own rendering. Measured on
// the real account, Instagram's settings page attached its profile anchor after ~1.7s while the
// probe checked once at 1.0s and reported UNKNOWN on a healthy session, which failed route
// qualification. Bounded waits are what the engineering contract asks for here.

/** Page double whose identity marker appears only after a set number of polls. */
function page({ url, appearsAfterChecks = 0, authUrl = null }) {
  let checks = 0;
  let current = url;
  return {
    evaluations: 0,
    async navigate(target) { current = target; },
    async currentUrl() { return authUrl && checks >= 1 ? authUrl : current; },
    async evaluate(expression) {
      this.evaluations += 1;
      // The real adapter runs this sleep inside the page, so it genuinely waits. A double that
      // returns immediately turns the bounded wait into a busy loop and hides the timing the
      // test is about.
      if (expression.startsWith("new Promise")) {
        const ms = Number(/setTimeout\(resolve, (\d+)\)/.exec(expression)?.[1] ?? 0);
        await new Promise((resolve) => setTimeout(resolve, ms));
        return null;
      }
      if (expression.startsWith("Boolean(")) return false;      // no auth/challenge marker
      checks += 1;
      return checks > appearsAfterChecks ? "/luca.erdkoenig/" : null;
    }
  };
}

const base = {
  probeUrl: "https://www.instagram.com/accounts/edit/",
  identitySelector: 'a[href="/luca.erdkoenig/"]',
  identityAttribute: "href",
  authUrlIncludes: ["/accounts/login"],
  navigate: false,
  identityPollMs: 100
};

test("a marker that renders late is still found instead of failing the session", async () => {
  const probe = new ConfiguredDomSessionProbe({ ...base, identityTimeoutMs: 3000 });
  const result = await probe.probe(page({ url: base.probeUrl, appearsAfterChecks: 4 }), {});
  assert.equal(result.state, "HEALTHY");
  assert.equal(result.observedHandle, "/luca.erdkoenig/");
});

test("a marker that never renders still ends as UNKNOWN, not as a pass", async () => {
  const probe = new ConfiguredDomSessionProbe({ ...base, identityTimeoutMs: 400 });
  const result = await probe.probe(page({ url: base.probeUrl, appearsAfterChecks: 10_000 }), {});
  assert.equal(result.state, "UNKNOWN");
  assert.match(result.note, /bounded wait/);
});

test("the wait is bounded rather than open-ended", async () => {
  const probe = new ConfiguredDomSessionProbe({ ...base, identityTimeoutMs: 300 });
  const started = Date.now();
  await probe.probe(page({ url: base.probeUrl, appearsAfterChecks: 10_000 }), {});
  // Generous ceiling: the point is that it terminates, not that it is fast.
  assert.ok(Date.now() - started < 5000);
});

test("a logged-out page is decided immediately and does not consume the wait", async () => {
  const probe = new ConfiguredDomSessionProbe({ ...base, identityTimeoutMs: 30_000 });
  const started = Date.now();
  const result = await probe.probe(page({ url: base.probeUrl, authUrl: "https://www.instagram.com/accounts/login/", appearsAfterChecks: 10_000 }), {});
  assert.equal(result.state, "AUTH_REQUIRED");
  assert.ok(Date.now() - started < 3000, "auth must not wait out the identity budget");
});

test("waiting never invents an identity that was not observed", async () => {
  const probe = new ConfiguredDomSessionProbe({ ...base, identityTimeoutMs: 400 });
  const result = await probe.probe(page({ url: base.probeUrl, appearsAfterChecks: 10_000 }), {});
  assert.equal(result.observedHandle, undefined);
});

test("a navigation race mid-probe is retried, not reported as UNREACHABLE", async () => {
  // A SPA tears down the execution context while navigating; CDP then rejects evaluations with
  // "Inspected target navigated or closed". One such moment failed a whole qualification run.
  let calls = 0;
  const flaky = {
    async navigate() {},
    async currentUrl() {
      calls += 1;
      if (calls <= 2) throw new Error("Inspected target navigated or closed");
      return "https://www.instagram.com/accounts/edit/";
    },
    async evaluate(expression) {
      if (expression.startsWith("Boolean(")) return false;
      return "/luca.erdkoenig/";
    }
  };
  const probe = new ConfiguredDomSessionProbe({ ...base, identityTimeoutMs: 3000 });
  const result = await probe.probe(flaky, {});
  assert.equal(result.state, "HEALTHY");
});

test("a page that stays unreachable until the deadline is still reported UNREACHABLE", async () => {
  const dead = {
    async navigate() {},
    async currentUrl() { throw new Error("Inspected target navigated or closed"); },
    async evaluate() { throw new Error("Inspected target navigated or closed"); }
  };
  const probe = new ConfiguredDomSessionProbe({ ...base, identityTimeoutMs: 400 });
  const result = await probe.probe(dead, {});
  assert.equal(result.state, "UNREACHABLE");
  assert.match(result.note, /bounded-wait deadline/);
});

test("a non-navigation failure still escapes immediately", async () => {
  const broken = {
    async navigate() {},
    async currentUrl() { throw new Error("WebSocket is not open"); },
    async evaluate() { return null; }
  };
  const probe = new ConfiguredDomSessionProbe({ ...base, identityTimeoutMs: 30_000 });
  const started = Date.now();
  const result = await probe.probe(broken, {});
  assert.equal(result.state, "UNREACHABLE");
  assert.ok(Date.now() - started < 3000, "an unknown failure must not burn the wait budget");
});
