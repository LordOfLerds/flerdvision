import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { ConfiguredDomSessionProbe } from "../dist/adapters/browser/configured-dom-probe.js";

// Instagram moved the profile link out of <nav> and dropped [role=navigation] entirely, so the
// old identity selector matched nothing and no login could ever verify. The naive repair --
// dropping the ancestor and matching a[href="/<handle>/"] anywhere -- would have been unsound:
// a feed showing a post by that account renders the same anchor while a different account is
// logged in. The probe is therefore scoped to the account-settings page, which exists only for
// the authenticated account.

const source = readFileSync(new URL("../src/application/headless-login.ts", import.meta.url).pathname, "utf8");

/** Minimal page double: only what ConfiguredDomSessionProbe actually calls. */
function page({ url, html }) {
  let current = url;
  const doc = html;
  return {
    navigated: [],
    async navigate(target) { this.navigated.push(target); current = target; },
    async currentUrl() { return current; },
    async evaluate(expression) {
      // The probe embeds the selector JSON-encoded, so it arrives with escaped quotes.
      const encoded = /document\.querySelector\((.*?)\)/s.exec(expression)?.[1];
      if (!encoded) return null;
      const selector = JSON.parse(encoded);
      const wanted = /a\[href="([^"]+)"\]/.exec(selector)?.[1];
      const hrefs = [...doc.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
      const present = wanted ? hrefs.includes(wanted) : false;
      if (expression.startsWith("Boolean(")) return present;
      return present ? wanted : null;
    }
  };
}

test("the identity probe targets the account-settings page, not the feed", () => {
  assert.match(source, /instagram\.com\/accounts\/edit\//);
  assert.match(source, /function identityUrl/);
});

test("the Instagram selector no longer requires a nav ancestor that Instagram removed", () => {
  assert.doesNotMatch(source, /nav a\[href="\/\$\{handle\}\/"\]/);
  assert.match(source, /a\[href="\/\$\{handle\}\/"\]/);
});

test("the settings page proves the exact account", async () => {
  const probe = new ConfiguredDomSessionProbe({
    probeUrl: "https://www.instagram.com/accounts/edit/",
    identitySelector: 'a[href="/luca.erdkoenig/"]',
    identityAttribute: "href",
    authUrlIncludes: ["/accounts/login"],
    navigate: false
  });
  const result = await probe.probe(page({
    url: "https://www.instagram.com/accounts/edit/",
    html: '<a href="/luca.erdkoenig/"><img alt="luca.erdkoenigs Profilbild"></a>'
  }), {});
  assert.equal(result.state, "HEALTHY");
  assert.equal(result.observedHandle, "/luca.erdkoenig/");
});

test("a different logged-in account on the settings page is not accepted", async () => {
  const probe = new ConfiguredDomSessionProbe({
    probeUrl: "https://www.instagram.com/accounts/edit/",
    identitySelector: 'a[href="/luca.erdkoenig/"]',
    identityAttribute: "href",
    authUrlIncludes: ["/accounts/login"],
    navigate: false
  });
  // The settings page of someone else shows only their own profile link.
  const result = await probe.probe(page({
    url: "https://www.instagram.com/accounts/edit/",
    html: '<a href="/someone.else/"><img alt="someone.elses Profilbild"></a>'
  }), {});
  assert.notEqual(result.state, "HEALTHY");
});

test("a logged-out visitor is redirected to login and classified as needing auth", async () => {
  const probe = new ConfiguredDomSessionProbe({
    probeUrl: "https://www.instagram.com/accounts/edit/",
    identitySelector: 'a[href="/luca.erdkoenig/"]',
    identityAttribute: "href",
    authUrlIncludes: ["/accounts/login"],
    navigate: false
  });
  const result = await probe.probe(page({ url: "https://www.instagram.com/accounts/login/?next=/accounts/edit/", html: "" }), {});
  assert.equal(result.state, "AUTH_REQUIRED");
});

test("the login loop does not navigate while the operator is in the login or challenge flow", () => {
  // Navigating mid-password or mid-2FA would destroy the attempt being waited for.
  assert.match(source, /inLoginFlow/);
  assert.match(source, /accounts\/login/);
  assert.match(source, /challenge\//);
  assert.match(source, /probeConfig\(channel, !inLoginFlow\)/);
});
