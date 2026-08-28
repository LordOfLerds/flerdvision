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
