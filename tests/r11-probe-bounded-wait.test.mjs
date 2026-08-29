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
