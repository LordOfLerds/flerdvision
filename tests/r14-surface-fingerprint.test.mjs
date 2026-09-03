import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeSurfaceFingerprint, describeSurfaceFingerprint, surfaceFingerprintMatches, currentSurfaceFingerprintOrUndefined } from "../dist/application/surface-fingerprint.js";
import { DEFAULT_QUALIFICATION_REPLAYS, germanReplayProgress, resolveQualificationReplays } from "../dist/application/qualification-policy.js";

function fakeDist(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "surface-fp-"));
  const files = {
    "adapters/browser/dom-ui-driver.js": "export const driver = 1;\n",
    "adapters/browser/nested/deep.js": "export const deep = 1;\n",
    "adapters/publish/declarative-platform-ui.js": "export const ui = 1;\n",
    "application/platform-execution-plan.js": "export const plan = 1;\n",
    "application/autonomous-surface-contract.js": "export const contract = 1;\n",
    "domain/platform-ui.js": "export const domainUi = 1;\n",
    "domain/platform-execution.js": "export const domainExec = 1;\n",
    // Not part of the surface: notifications, planner, docs.
    "application/notifications.js": "export const notify = 1;\n",
    "application/distribution-planner.js": "export const planner = 1;\n",
    ...overrides
  };
  for (const [relative, content] of Object.entries(files)) {
    const path = join(root, ...relative.split("/"));
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content, "utf8");
  }
  return root;
}

test("surface fingerprint is stable for identical built files", () => {
  const a = fakeDist();
  const b = fakeDist();
  assert.equal(computeSurfaceFingerprint(a), computeSurfaceFingerprint(b));
  assert.equal(describeSurfaceFingerprint(computeSurfaceFingerprint(a)).length, 12);
});

test("surface fingerprint changes when a surface-driving file changes", () => {
  const base = computeSurfaceFingerprint(fakeDist());
  assert.notEqual(base, computeSurfaceFingerprint(fakeDist({ "adapters/browser/dom-ui-driver.js": "export const driver = 2;\n" })));
  assert.notEqual(base, computeSurfaceFingerprint(fakeDist({ "adapters/browser/nested/deep.js": "export const deep = 2;\n" })));
  assert.notEqual(base, computeSurfaceFingerprint(fakeDist({ "adapters/publish/declarative-platform-ui.js": "export const ui = 2;\n" })));
  assert.notEqual(base, computeSurfaceFingerprint(fakeDist({ "domain/platform-ui.js": "export const domainUi = 2;\n" })));
  assert.notEqual(base, computeSurfaceFingerprint(fakeDist({ "application/platform-execution-plan.js": "export const plan = 2;\n" })));
});

test("a commit outside the surface leaves the fingerprint untouched", () => {
  const base = computeSurfaceFingerprint(fakeDist());
  assert.equal(base, computeSurfaceFingerprint(fakeDist({ "application/notifications.js": "export const notify = 99;\n" })));
  assert.equal(base, computeSurfaceFingerprint(fakeDist({ "application/distribution-planner.js": "export const planner = 99;\n" })));
});

test("an unbuilt tree fails loudly and reports as unknown to fail-soft callers", () => {
  const empty = mkdtempSync(join(tmpdir(), "surface-fp-empty-"));
  assert.throws(() => computeSurfaceFingerprint(empty), /No built surface files/);
  assert.equal(currentSurfaceFingerprintOrUndefined(empty), undefined);
});

test("only an equal recorded fingerprint counts as current", () => {
  assert.equal(surfaceFingerprintMatches("abc", "abc"), true);
  assert.equal(surfaceFingerprintMatches("abc", "def"), false);
  assert.equal(surfaceFingerprintMatches(undefined, "abc"), false);
  assert.equal(surfaceFingerprintMatches("abc", undefined), false);
});

test("the running dist directory has a fingerprint", () => {
  assert.equal(typeof computeSurfaceFingerprint(), "string");
  assert.equal(computeSurfaceFingerprint().length, 64);
});

test("qualification replay count defaults to one and is env-configurable", () => {
  assert.equal(DEFAULT_QUALIFICATION_REPLAYS, 1);
  assert.equal(resolveQualificationReplays({}), 1);
  assert.equal(resolveQualificationReplays({ FLERDVISION_QUALIFICATION_REPLAYS: "3" }), 3);
  assert.equal(resolveQualificationReplays({ FLERDVISION_QUALIFICATION_REPLAYS: "  " }), 1);
  assert.throws(() => resolveQualificationReplays({ FLERDVISION_QUALIFICATION_REPLAYS: "0" }), /integer from 1 to 10/);
  assert.throws(() => resolveQualificationReplays({ FLERDVISION_QUALIFICATION_REPLAYS: "zwei" }), /integer from 1 to 10/);
  assert.equal(germanReplayProgress(1, 1), "1/1 Trockenlauf");
  assert.equal(germanReplayProgress(2, 3), "2/3 Trockenläufe");
});
