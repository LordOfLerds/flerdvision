import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The login step waits for a human to find a browser window, type a password and clear 2FA.
// A fixed, unstated, unchangeable window is the wrong shape for that, and it cost two real
// acceptance windows before it was noticed.

const cliSource = readFileSync(new URL("../src/cli/flerdvision.ts", import.meta.url).pathname, "utf8");
const loginSource = readFileSync(new URL("../src/application/headless-login.ts", import.meta.url).pathname, "utf8");

test("the login window is operator-configurable, not hard-wired", () => {
  assert.match(cliSource, /--login-timeout/, "the CLI must expose a flag");
  assert.match(cliSource, /FLERDVISION_LOGIN_TIMEOUT_MINUTES/, "and an environment override");
  assert.match(cliSource, /timeoutMs:\s*loginTimeoutMinutes\s*\*\s*60_000/, "the flag must actually reach the service");
});

test("the configured window is bounded to a sane range", () => {
  // positiveInteger(..., default, name, min, max) -- an unbounded wait would hold a browser
  // profile lock indefinitely, which is worse than failing.
  assert.match(cliSource, /"--login-timeout",\s*1,\s*120/);
});

test("the timeout message states how long it waited and how to wait longer", () => {
  assert.match(loginSource, /timed out for \$\{channel\.key\} after \$\{Math\.round\(timeoutMs \/ 60_000\)\} minutes/);
  assert.match(loginSource, /--login-timeout/);
  // It must also say what was actually observed, so the operator can tell "I never logged in"
  // from "I logged in and detection failed" without reading cookie stores by hand.
  assert.match(loginSource, /no verified @\$\{channel\.handle\} session/);
});

test("the default stays 15 minutes so existing behaviour is unchanged", () => {
  assert.match(loginSource, /input\.timeoutMs \?\? 15 \* 60_000/);
  assert.match(cliSource, /"--login-timeout"/);
  assert.match(cliSource, /,\s*15,\s*"--login-timeout"/);
});

// --- the probe must not touch the browser while the operator is still signing in ---

test("no navigation or probing happens before a platform session cookie exists", () => {
  // Instagram's code-entry pages live on paths the URL allowlist does not know, so the probe
  // navigated the operator away mid-2FA every few seconds. The session cookies are the honest
  // signal: they exist exactly from the moment authentication succeeded.
  assert.match(loginSource, /if \(platform === "instagram" \|\| platform === "tiktok"\) return \["sessionid"\];/);
  assert.match(loginSource, /the browser will not be touched/);
  const cookieGate = loginSource.indexOf("if (!authenticated) {");
  const probeCall = loginSource.indexOf("BrowserSessionHealthService(control, new ConfiguredDomSessionProbe");
  assert.ok(cookieGate > 0 && cookieGate < probeCall, "the cookie gate must sit before any probe");
});

test("youtube gates on the Google authenticated-session cookies, not visitor or logout-surviving ones", () => {
  // Google's mid-login pages live on accounts.google.com paths (2FA, passkey, challenge) the URL
  // allowlist cannot enumerate, so youtube needs the same cookie gate. SAPISID and the
  // __Secure-*PAPISID/__Secure-1PSID family exist only for a signed-in Google account; visitor
  // cookies (VISITOR_INFO1_LIVE, YSC, CONSENT) exist for everyone, and LOGIN_INFO can survive
  // logout, so neither may be a candidate.
  assert.match(loginSource, /if \(platform === "youtube"\) return \["SAPISID", "__Secure-1PAPISID", "__Secure-3PAPISID", "__Secure-1PSID"\];/);
  const returns = [...loginSource.matchAll(/return \[[^\]]*\];/g)].map((match) => match[0]);
  for (const line of returns) {
    assert.doesNotMatch(line, /LOGIN_INFO|VISITOR_INFO1_LIVE|YSC|CONSENT/, `logout-surviving or visitor cookie offered as login signal: ${line}`);
  }
  // Unknown platforms must fall back to the legacy URL guard instead of guessing a cookie.
  assert.match(loginSource, /return \[\];\n\}/);
});

test("the cookie gate continues the wait instead of failing", () => {
  const idx = loginSource.indexOf("if (!authenticated) {");
  const block = loginSource.slice(idx, idx + 600);
  assert.match(block, /continue;/);
  assert.match(block, /heartbeat/);
  assert.doesNotMatch(block, /throw/);
});

test("platforms without a known session cookie keep the legacy URL guard", () => {
  assert.match(loginSource, /Legacy guard for platforms without a known session cookie/);
  assert.match(loginSource, /inLoginFlow/);
});
