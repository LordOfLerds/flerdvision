import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { postingProfile } from "../dist/application/workspace-spec-compiler.js";
import { parseWorkspaceSpec } from "../dist/domain/workspace-spec.js";

// Instagram removed the share-to-feed choice from its compose surface with the reel merge; the
// expanded advanced panel of the live page holds no such control (captured in the qualification
// evidence). The compiler nevertheless invented shareToFeed=true as a default for reels, and the
// settings phase then demanded a control the surface cannot offer -- an unwinnable requirement
// nobody had actually asked for.

const settingsSource = readFileSync(new URL("../src/adapters/browser/autonomous-surface-settings.ts", import.meta.url).pathname, "utf8");

function specWith(settings) {
  return parseWorkspaceSpec({
    schemaVersion: 1,
    workspace: { id: "t", name: "T", ownerEmail: "info@flerdvision.com", timezone: "Europe/Vienna", runtimeRoot: "runtime" },
    source: { kind: "google_drive", root: "https://drive.google.com/drive/folders/x", structure: "auto", activation: "IMPORT_BACKLOG" },
    channels: [{
      key: "ig", name: "IG", platform: "instagram", handle: "h",
      formats: [{ type: "reel", times: ["12:00"], sourceMatch: ["a"], captionTemplate: "{filename}", hashtags: [], verificationMarker: true, requirement: "REQUIRED", settings }]
    }],
    notifications: { onSuccess: "daily_summary", onBlocked: "immediate", onUncertain: "immediate" },
    privateTest: { enabled: false, accountPrivate: false, approvedFollowers: 0, contactsSyncOff: false, crossPostingOff: false, autoCleanup: false }
  });
}

function profileOf(spec) {
  const channel = spec.channels[0];
  return postingProfile(channel, channel.formats[0]);
}

test("compiler records which settings the operator actually wrote", () => {
  const explicitProfile = profileOf(specWith({ shareToFeed: true, commentsEnabled: true }));
  assert.deepEqual([...explicitProfile.explicitSettings].sort(), ["commentsEnabled", "shareToFeed"]);

  const defaultedProfile = profileOf(specWith({}));
  assert.deepEqual(defaultedProfile.explicitSettings, []);
  // The defaults themselves are unchanged -- only their provenance is now known.
  assert.equal(defaultedProfile.shareToFeed, true);
  assert.equal(defaultedProfile.commentsEnabled, true);
});

test("a control absent on the surface is tolerated only for settings nobody demanded", () => {
  assert.match(settingsSource, /optionalWhenAbsent\?: boolean/);
  assert.match(settingsSource, /if \(input\.optionalWhenAbsent\) \{/);
  assert.match(settingsSource, /outcome: "SKIPPED"/);
  // An explicit operator demand for an absent control must keep failing.
  assert.match(settingsSource, /throw new UiActionExecutionError\(`Could not locate required setting/);
});

test("the skip is derived from compiler provenance, never hardcoded per setting", () => {
  assert.match(settingsSource, /optionalWhenAbsent: !explicit\("shareToFeed"\)/);
  assert.match(settingsSource, /optionalWhenAbsent: !explicit\("commentsEnabled"\)/);
  assert.match(settingsSource, /optionalWhenAbsent: !explicit\("crosspostFacebook"\)/);
});

test("configs compiled before provenance existed stay strict", () => {
  // explicitSettings === undefined means unknown, and unknown must be treated as explicit.
  assert.match(settingsSource, /input\.postingProfile\.explicitSettings === undefined \|\| /);
});

test("a skipped absent setting still captures the surface as evidence", () => {
  const idx = settingsSource.indexOf("if (input.optionalWhenAbsent) {");
  const before = settingsSource.slice(idx - 600, idx);
  assert.match(before, /-missing/);
  assert.match(before, /captureBoundary/);
});
