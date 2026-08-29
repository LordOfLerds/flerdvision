import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The privacy attestation protects an Instagram test through account privacy, but on platforms
// with per-post visibility the post's own audience decides who sees it. Before this gate, a
// tiktok channel left on its compiled default ("everyone") passed every privacy gate and would
// have published publicly during a "private" test. Found by the gate-analysis agent; the
// zero-viewer contract must extend to visibility wherever visibility exists.

const source = readFileSync(new URL("../src/application/headless-demo.ts", import.meta.url).pathname, "utf8");

test("the private publish gate demands zero-viewer visibility per platform", () => {
  assert.match(source, /ZERO_VIEWER_VISIBILITY/);
  assert.match(source, /tiktok: "only_you"/);
  assert.match(source, /youtube: "private"/);
});

test("every format of the selected channel is checked, not only the first", () => {
  assert.match(source, /for \(const format of channel\.formats\)/);
});

test("an unset visibility is refused as the platform default it would become", () => {
  assert.match(source, /unset \(platform default\)/);
  assert.match(source, /would publish publicly/);
});

test("instagram stays governed by account privacy, not by a visibility field it does not have", () => {
  // The map deliberately holds no instagram entry; the account-privacy attestation above governs.
  const idx = source.indexOf("ZERO_VIEWER_VISIBILITY");
  const block = source.slice(idx, idx + 200);
  assert.doesNotMatch(block, /instagram/);
  assert.match(source, /if \(!required\) continue;/);
});

test("the gate sits before anything irreversible is reachable", () => {
  const gate = source.indexOf("ZERO_VIEWER_VISIBILITY");
  const start = source.indexOf("commands.start(");
  const invoke = source.indexOf("invokeFinal");
  assert.ok(gate > 0 && gate < start && start < invoke, "visibility must be judged before the run even starts");
});

// --- the same rule at the shared choke point, closing CLI/HTTP bypasses ---

const commands = readFileSync(new URL("../src/adapters/runtime/workspace-private-e2e.ts", import.meta.url).pathname, "utf8");

test("the choke point every entry path shares enforces zero-viewer visibility", () => {
  // headless demo, CLI and the legacy HTTP surface all start runs through
  // WorkspacePrivateE2ECommands.start; a gate only in the demo would leave two open doors.
  assert.match(commands, /assertZeroViewerVisibility/);
  assert.match(commands, /this\.assertZeroViewerVisibility\(intentId\)/);
  const startIdx = commands.indexOf("start(intentId:string");
  const checkIdx = commands.indexOf("this.assertZeroViewerVisibility(intentId)");
  const runStart = commands.indexOf("this.runService.start", startIdx);
  assert.ok(checkIdx > startIdx && checkIdx < runStart, "the check must run before the run record exists");
});

test("the choke point judges the compiled posting profile, not the spec", () => {
  assert.match(commands, /postingProfiles\.find/);
  assert.match(commands, /"only_you"/);
  assert.match(commands, /"private"/);
  assert.match(commands, /A default visibility would publish publicly/);
});
