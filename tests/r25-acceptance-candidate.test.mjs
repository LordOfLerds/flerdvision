import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("acceptance candidate freezes release, surface and spec before any test-now runtime opens", () => {
  const candidate = readFileSync(new URL("../src/application/acceptance-candidate.ts", import.meta.url).pathname, "utf8");
  const command = readFileSync(new URL("../src/application/acceptance-test-now-command.ts", import.meta.url).pathname, "utf8");
  const cli = readFileSync(new URL("../src/cli/flerdvision.ts", import.meta.url).pathname, "utf8");

  assert.match(candidate, /releaseSha/);
  assert.match(candidate, /surfaceFingerprint/);
  assert.match(candidate, /specDigest/);
  assert.match(candidate, /FLERDVISION_WORKSPACE_ROLE/);
  assert.match(candidate, /test-now:/);
  assert.match(candidate, /PUBLISH_UNCERTAIN/);

  const gate = command.indexOf("assertCurrent()");
  const runtimeOpen = command.indexOf("new WorkspaceDistributionRuntime");
  assert.ok(gate >= 0 && runtimeOpen >= 0 && gate < runtimeOpen, "candidate gate must run before runtime store/browser composition");
  assert.match(cli, /acceptance \[status\|freeze\]/);
  assert.match(cli, /runAcceptanceCli/);
});
