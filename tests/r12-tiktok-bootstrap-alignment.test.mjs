import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { surfaceExecutionBootstrapUrl } from "../dist/adapters/browser/surface-bootstrap.js";

// The explorer bootstrapped TikTok on /upload while the execution runner bootstrapped the root
// feed. A contract recorded on /upload skips the optional OPEN_UPLOAD click (the file input is
// already present, so no OPEN_UPLOAD step is recorded); replaying that contract from the root
// feed can therefore never find the file input. Both sides must derive the surface bootstrap
// URL from one shared function so the asymmetry cannot silently return.

const explorerSource = readFileSync(new URL("../src/adapters/browser/autonomous-surface-explorer.ts", import.meta.url).pathname, "utf8");
const runnerSource = readFileSync(new URL("../src/adapters/browser/platform-execution-runner.ts", import.meta.url).pathname, "utf8");

test("the shared bootstrap starts TikTok directly on the studio upload page", () => {
  // The public /upload path redirects into the studio and left the app half-booted: a rendered
  // "TikTok Studio" shell with no controls at all.
  assert.equal(surfaceExecutionBootstrapUrl("tiktok"), "https://www.tiktok.com/tiktokstudio/upload");
});

test("Instagram and YouTube bootstraps are unchanged by the extraction", () => {
  assert.equal(surfaceExecutionBootstrapUrl("instagram"), "https://www.instagram.com/");
  assert.equal(surfaceExecutionBootstrapUrl("youtube"), "https://studio.youtube.com/");
});

test("the explorer derives its bootstrap from the shared function and owns no platform URL", () => {
  assert.match(explorerSource, /from "\.\/surface-bootstrap\.js"/);
  assert.match(explorerSource, /surfaceExecutionBootstrapUrl\(input\.postingProfile\.platform\)/);
  assert.doesNotMatch(explorerSource, /tiktok\.com/);
  assert.doesNotMatch(explorerSource, /function bootstrapUrl/);
});

test("the execution runner derives its bootstrap from the shared function and owns no platform URL", () => {
  assert.match(runnerSource, /from "\.\/surface-bootstrap\.js"/);
  assert.match(runnerSource, /surfaceExecutionBootstrapUrl\(plan\.intent\.platform\)/);
  assert.doesNotMatch(runnerSource, /tiktok\.com/);
  assert.doesNotMatch(runnerSource, /function bootstrapUrl/);
});

test("explorer and runner agree on every platform by construction", () => {
  for (const platform of ["instagram", "tiktok", "youtube"]) {
    // Both call sites resolve through the identical function; this pins the contract that any
    // future per-platform change lands in surface-bootstrap.ts and nowhere else.
    assert.equal(typeof surfaceExecutionBootstrapUrl(platform), "string");
    assert.ok(surfaceExecutionBootstrapUrl(platform).startsWith("https://"));
  }
});

test("an optional opening step is skipped once the upload surface is already reached", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../src/adapters/browser/autonomous-surface-explorer.ts", import.meta.url).pathname, "utf8");
  // TikTok's nav "Hochladen" navigates AWAY from the studio upload page; the required upload
  // step then found no file input at all.
  assert.match(source, /let uploadReady = false;/);
  assert.match(source, /Date\.now\(\) \+ 8_000/);
  assert.match(source, /if \(uploadReady && !step\.required\)/);
  assert.match(source, /upload surface already reached/);
});

test("exploration waits for a rendered surface instead of a fixed settle", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../src/adapters/browser/autonomous-surface-explorer.ts", import.meta.url).pathname, "utf8");
  // TikTok Studio's document was still a 1.5 KB shell after the fixed 1.5 s settle.
  assert.match(source, /Date\.now\(\) \+ 40_000/);
  assert.match(source, /button, \[role="button"\], input, textarea'\)\.length > 0/);
});
