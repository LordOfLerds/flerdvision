import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";

// "Einfache Portabilität und Setup auf VPS" (operator decision 2026-08-30). The 510-line
// deployment document stays the reference, but the mechanical part of it must be one command --
// and that command must stop exactly where authorization begins.

const script = readFileSync(new URL("../deploy/install-vps.sh", import.meta.url).pathname, "utf8");

test("the installer is executable and fails fast", () => {
  assert.equal(statSync(new URL("../deploy/install-vps.sh", import.meta.url).pathname).mode & 0o111, 0o111);
  assert.match(script, /set -euo pipefail/);
});

test("it refuses to install without a pinned release", () => {
  assert.match(script, /--release <sha> is required/);
});

test("it stops at the boundaries a human owns", () => {
  // No secret is ever written, no spec is generated, and the posting daemon is never enabled.
  assert.doesNotMatch(script, /systemctl enable[^\n]*flerdvision-daemon/);
  assert.match(script, /the posting daemon stays disabled until the canary authorization/);
  assert.match(script, /TODO  fill in|todo "fill in/);
});

test("a red suite on the pinned release aborts the installation", () => {
  assert.match(script, /npm test[\s\S]{0,120}die "test suite is red/);
});

test("the check mode verifies without changing anything", () => {
  const idx = script.indexOf("if $CHECK_ONLY; then");
  const block = script.slice(idx, script.indexOf("exit $status", idx));
  assert.doesNotMatch(block, /apt-get|systemctl enable|mkdir|install -m/);
});

test("the deployment document points at the installer", () => {
  const doc = readFileSync(new URL("../docs/24-VPS-DEPLOYMENT.md", import.meta.url).pathname, "utf8");
  assert.match(doc, /deploy\/install-vps\.sh --repo/);
  assert.match(doc, /--check/);
});
