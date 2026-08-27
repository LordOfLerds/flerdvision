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

test("explicit times are canonicalized chronologically and must agree with frequency", () => {
  const input = base();
  input.channels[0].formats[0] = { type: "reel", times: ["20:00", "09:00"], frequencyPerDay: 2 };
  assert.deepEqual(parseWorkspaceSpec(input).channels[0].formats[0].times, ["09:00", "20:00"]);
  input.channels[0].formats[0].frequencyPerDay = 3;
  assert.throws(() => parseWorkspaceSpec(input), /must equal the number of explicit times/);
});

test("platform and format cannot be combined inconsistently", () => {
  const invalid = base();
  invalid.channels[0].formats[0].type = "tiktok";
  assert.throws(() => parseWorkspaceSpec(invalid), WorkspaceSpecError);
});

test("platform-specific settings cannot leak into another platform", () => {
  const invalid = base();
  invalid.channels[0].formats[0].settings = { visibility: "everyone" };
  assert.throws(() => parseWorkspaceSpec(invalid), /not valid for instagram/);
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

  const unsafe = base();
  unsafe.privateTest = { enabled: true, accountPrivate: true, approvedFollowers: 1, contactsSyncOff: true, crossPostingOff: true, autoCleanup: false };
  assert.throws(() => parseWorkspaceSpec(unsafe), /zero approved followers/);
});

test("duplicate keys, formats and platform-handle accounts fail closed", () => {
  const duplicateChannel = base();
  duplicateChannel.channels.push(structuredClone(duplicateChannel.channels[0]));
  assert.throws(() => parseWorkspaceSpec(duplicateChannel), /channel keys must be unique/);

  const duplicateFormat = base();
  duplicateFormat.channels[0].formats.push(structuredClone(duplicateFormat.channels[0].formats[0]));
  assert.throws(() => parseWorkspaceSpec(duplicateFormat), /duplicate types/);

  const duplicateAccount = base();
  const second = structuredClone(duplicateAccount.channels[0]);
  second.key = "instagram-secondary-definition";
  duplicateAccount.channels.push(second);
  assert.throws(() => parseWorkspaceSpec(duplicateAccount), /platform\/handle account may appear only once/);
});
