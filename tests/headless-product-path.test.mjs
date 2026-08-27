import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const cli = readFileSync("src/cli/flerdvision.ts", "utf8");

test("default start and demo use one headless command", () => {
  assert.match(pkg.scripts.start, /flerdvision -- auto/);
  assert.match(pkg.scripts.demo, /flerdvision -- demo/);
  assert.equal(pkg.scripts["control-center"], undefined);
  assert.equal(pkg.scripts["setup-ui"], undefined);
  assert.equal(pkg.scripts.ops, undefined);
});

test("old HTTP surfaces are explicitly quarantined as legacy", () => {
  for (const key of ["legacy:control-center", "legacy:setup-ui", "legacy:ops", "legacy:platform-ui", "legacy:e2e"]) {
    assert.equal(typeof pkg.scripts[key], "string", `${key} must remain named as legacy until deletion`);
  }
});

test("canonical product CLI does not import any setup, control-center or ops HTTP server", () => {
  assert.doesNotMatch(cli, /adapters\/control/);
  assert.doesNotMatch(cli, /adapters\/setup/);
  assert.doesNotMatch(cli, /adapters\/ops\/http-server/);
  assert.match(cli, /HeadlessAutonomousRuntime/);
  assert.match(cli, /runHeadlessDemo/);
  assert.match(cli, /inspectHeadlessWorkspace/);
});
