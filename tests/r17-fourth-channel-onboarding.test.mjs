import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonDistributionConfigurationStore } from "../dist/adapters/distribution/json-config-store.js";
import { SqliteControlPlaneStore } from "../dist/adapters/storage/sqlite.js";
import { WorkspaceSpecCompiler } from "../dist/application/workspace-spec-compiler.js";
import { parseWorkspaceSpec } from "../dist/domain/workspace-spec.js";

// Goal C: channel number 4 can be added by someone with no chat context. This exercises the real
// compiler (not a mock) with a temp spec that adds a fourth channel -- a second Instagram
// channel, distinct from the shipped instagram/tiktok/youtube example -- each with its own
// distinct Drive folder, and asserts the compile produces exactly one lane per distinct source
// folder: four channels, four folders, four lanes, four routes.

function fourChannelSpec() {
  return parseWorkspaceSpec({
    schemaVersion: 1,
    workspace: { id: "flerdvision", name: "Flerdvision Autopost", ownerEmail: "info@flerdvision.com", timezone: "Europe/Vienna", runtimeRoot: "runtime" },
    source: { kind: "google_drive", root: "https://drive.google.com/drive/folders/0123456789abcdef", structure: "auto", activation: "IMPORT_BACKLOG", maxDepth: 4 },
    channels: [
      { key: "instagram-flerdvision", name: "Flerdvision Instagram", platform: "instagram", handle: "flerdvision", formats: [{ type: "reel", sourceMatch: ["instagram", "reels"], captionTemplate: "{filenameText}", requirement: "REQUIRED", verificationMarker: false, settings: {} }] },
      { key: "tiktok-flerdvision", name: "Flerdvision TikTok", platform: "tiktok", handle: "flerdvision", formats: [{ type: "tiktok", sourceMatch: ["tiktok"], captionTemplate: "{filenameText} {filenameHashtags}", requirement: "REQUIRED", verificationMarker: false, settings: { visibility: "only_you" } }] },
      { key: "youtube-flerdvision", name: "Flerdvision YouTube", platform: "youtube", handle: "flerdvision", formats: [{ type: "short", sourceMatch: ["youtube", "shorts"], titleTemplate: "{filenameText}", requirement: "REQUIRED", verificationMarker: false, settings: { visibility: "private", madeForKids: false } }] },
      // Channel number 4: added by an operator with no chat context, following docs/27's
      // trial_reel template for a second, brand-new Instagram test channel with its own folder.
      { key: "instagram-flerdvision-test", name: "Flerdvision Instagram Test", platform: "instagram", handle: "flerdvision_test", formats: [{ type: "trial_reel", sourceMatch: ["trial"], captionTemplate: "{filenameText}", requirement: "REQUIRED", verificationMarker: true, settings: {} }] }
    ],
    notifications: { onSuccess: "daily_summary", onBlocked: "immediate", onUncertain: "immediate" },
    privateTest: { enabled: true, accountPrivate: true, approvedFollowers: 0, contactsSyncOff: true, crossPostingOff: true, autoCleanup: false }
  });
}

function fourFolderTopology(spec) {
  const nodes = [{ folderId: "root", folderRef: "root", folderPath: "Drive / Flerdvision", name: "Flerdvision", depth: 0, directVideoCount: 0, totalVideoCount: 4, childFolderCount: 4 }];
  const streams = spec.channels.map((channel) => {
    const format = channel.formats[0];
    const folderId = `folder-${channel.key}`;
    nodes.push({ folderId, folderRef: folderId, folderPath: `Drive / Flerdvision / ${channel.name}`, name: channel.name, depth: 1, directVideoCount: 1, totalVideoCount: 1, childFolderCount: 0 });
    return { channelKey: channel.key, platform: channel.platform, format: format.type, folderRef: folderId, folderPath: `Drive / Flerdvision / ${channel.name}`, totalVideoCount: 1, matchedBy: "explicit", score: 30 };
  });
  return { rootId: "root", rootPath: "Drive / Flerdvision", nodes, streams, warnings: [], verified: true };
}

test("a temp spec with a fourth channel compiles to four lanes, four accounts and four routes", () => {
  const root = mkdtempSync(join(tmpdir(), "flerdvision-fourth-channel-"));
  const configDir = join(root, "config");
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const config = new JsonDistributionConfigurationStore(join(configDir, "distribution.json"));
  const control = new SqliteControlPlaneStore(join(root, "flerdvision.sqlite"));
  try {
    const spec = fourChannelSpec();
    assert.equal(spec.channels.length, 4, "the temp spec really adds a fourth channel");
    const topology = fourFolderTopology(spec);
    const report = new WorkspaceSpecCompiler(config, control, configDir).compile(spec, topology, "2026-09-03T08:00:00Z");
    assert.equal(report.accounts, 4);
    assert.equal(report.routes, 4, "one route per channel format");
    assert.equal(report.lanes, 4, "four distinct source folders become four distinct lanes");
    assert.equal(report.warnings.length, 0);

    const stored = config.load();
    const platforms = stored.config.routes.map((route) => route.platform).sort();
    assert.deepEqual(platforms, ["instagram", "instagram", "tiktok", "youtube"]);
    const fourthAccount = stored.config.routes.find((route) => route.accountId === "account:instagram:instagram-flerdvision-test");
    assert.ok(fourthAccount, "the fourth channel's route is present under its own stable account id");
  } finally {
    control.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
  }
});
