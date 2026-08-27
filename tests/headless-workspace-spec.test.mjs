import test from "node:test";
import assert from "node:assert/strict";
import { parseWorkspaceSpec, WorkspaceSpecError } from "../dist/domain/workspace-spec.js";

function base() {
  return {
    schemaVersion: 1,
    workspace: { id: "Flerdvision Demo", name: "Flerdvision" },
    source: { kind: "local_folder", root: "/tmp/flerdvision-source", structure: "auto", activation: "IMPORT_BACKLOG" },
    channels: [{
      key: "Instagram Main",
      name: "Instagram Main",
      platform: "instagram",
      handle: "@flerdvision",
      formats: [{ type: "reel", frequencyPerDay: 2, sourceMatch: ["instagram", "reels"] }]
    }]
  };
}

test("one spec normalizes the full user-facing contract and defaults the Flerdvision owner", () => {
  const parsed = parseWorkspaceSpec(base());
  assert.equal(parsed.workspace.id, "flerdvision-demo");
  assert.equal(parsed.workspace.ownerEmail, "info@flerdvision.com");
  assert.equal(parsed.workspace.timezone, "Europe/Vienna");
  assert.equal(parsed.channels[0].handle, "flerdvision");
  assert.deepEqual(parsed.channels[0].formats[0].times, ["12:00", "19:00"]);
  assert.equal(parsed.channels[0].formats[0].settings.commentsEnabled, undefined);
  assert.equal(parsed.notifications.onUncertain, "immediate");
});

test("platform and format cannot be combined inconsistently", () => {
  const invalid = base();
  invalid.channels[0].formats[0].type = "tiktok";
  assert.throws(() => parseWorkspaceSpec(invalid), WorkspaceSpecError);
});

test("private final-action tests require explicit safety facts rather than hidden defaults", () => {
  const parsed = parseWorkspaceSpec(base());
  assert.deepEqual(parsed.privateTest, {
    enabled: false,
    accountPrivate: false,
    approvedFollowers: 0,
    contactsSyncOff: false,
    crossPostingOff: false,
    autoCleanup: false
  });
});

test("duplicate channel keys and duplicate formats fail closed", () => {
  const duplicateChannel = base();
  duplicateChannel.channels.push(structuredClone(duplicateChannel.channels[0]));
  assert.throws(() => parseWorkspaceSpec(duplicateChannel), /channel keys must be unique/);

  const duplicateFormat = base();
  duplicateFormat.channels[0].formats.push(structuredClone(duplicateFormat.channels[0].formats[0]));
  assert.throws(() => parseWorkspaceSpec(duplicateFormat), /duplicate types/);
});
