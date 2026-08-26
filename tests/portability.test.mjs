import test from "node:test";
import assert from "node:assert/strict";
import {
  chromiumCandidates,
  findChromiumExecutable,
  resolveChromiumExecutablePath,
  LINUX_CHROMIUM_CANDIDATES,
  DARWIN_CHROMIUM_CANDIDATES
} from "../dist/adapters/browser/resolve-chromium.js";

// The same release is promoted Luca's Mac -> Fabian's Mac -> Linux VPS. A browser path that is
// correct on one of those and wrong on the others is the defect this suite exists to prevent.

test("linux hosts keep the packaged chromium as first candidate", () => {
  assert.equal(chromiumCandidates("linux")[0], "/usr/bin/chromium");
  assert.deepEqual(chromiumCandidates("linux"), LINUX_CHROMIUM_CANDIDATES);
  assert.ok(LINUX_CHROMIUM_CANDIDATES.includes("/usr/bin/chromium-browser"));
  assert.ok(LINUX_CHROMIUM_CANDIDATES.includes("/usr/bin/google-chrome"));
});

test("macOS hosts resolve the app bundle, never a linux path", () => {
  assert.deepEqual(chromiumCandidates("darwin"), DARWIN_CHROMIUM_CANDIDATES);
  assert.ok(chromiumCandidates("darwin").every((path) => !path.startsWith("/usr/bin/")));
});

test("an explicit deployment path always wins over platform defaults", () => {
  const env = { CHROMIUM_EXECUTABLE_PATH: "/opt/pinned/chromium" };
  assert.equal(resolveChromiumExecutablePath(env, "linux"), "/opt/pinned/chromium");
  assert.equal(resolveChromiumExecutablePath(env, "darwin"), "/opt/pinned/chromium");
});

test("a misconfigured explicit path surfaces itself rather than silently falling back", () => {
  const env = { CHROMIUM_EXECUTABLE_PATH: "/does/not/exist/chromium" };
  // resolve* is for spawning: the operator must see the path they actually set in the failure.
  assert.equal(resolveChromiumExecutablePath(env, "linux"), "/does/not/exist/chromium");
  // find* is for graceful degradation: a path that cannot run is not a usable browser.
  assert.equal(findChromiumExecutable(env, "linux"), undefined);
});

test("resolution never returns an empty path on either deployment platform", () => {
  for (const os of ["linux", "darwin"]) {
    const resolved = resolveChromiumExecutablePath({}, os);
    assert.ok(typeof resolved === "string" && resolved.length > 0);
  }
});

test("this host resolves a real, executable browser", () => {
  // Fails loudly on a host that install-mac.sh / install-vps.sh would have rejected at preflight.
  assert.ok(findChromiumExecutable() !== undefined, "no executable Chromium/Chrome found on this host");
});
