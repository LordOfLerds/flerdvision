import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonDistributionConfigurationStore } from "../dist/adapters/distribution/json-config-store.js";
import { SqliteControlPlaneStore } from "../dist/adapters/storage/sqlite.js";
import { WorkspaceSpecCompiler } from "../dist/application/workspace-spec-compiler.js";
import { parseWorkspaceSpec } from "../dist/domain/workspace-spec.js";

function parsedSpec() {
  return parseWorkspaceSpec({
    schemaVersion: 1,
    workspace: { id: "compiler", name: "Compiler" },
    source: { kind: "google_drive", root: "1AbCdEfGhIjKlMnOp", structure: "auto", activation: "IMPORT_BACKLOG" },
    channels: [
      { key: "ig", name: "Instagram", platform: "instagram", handle: "flerdvision", formats: [{ type: "reel", times: ["12:00", "19:00"], sourceMatch: ["reels"], verificationMarker: true }] },
      { key: "tt", name: "TikTok", platform: "tiktok", handle: "flerdvision", formats: [{ type: "tiktok", times: ["13:00", "20:00"], sourceMatch: ["reels"], verificationMarker: true }] }
    ]
  });
}

const topology = {
  rootId: "1AbCdEfGhIjKlMnOp",
  rootPath: "Drive / Flerdvision",
  verified: true,
  warnings: [],
  nodes: [{ folderId: "reels", folderRef: "reels", folderPath: "Drive / Flerdvision / Reels", name: "Reels", depth: 1, directVideoCount: 2, totalVideoCount: 2, childFolderCount: 0 }],
  streams: [
    { channelKey: "ig", platform: "instagram", format: "reel", folderRef: "reels", folderPath: "Drive / Flerdvision / Reels", totalVideoCount: 2, matchedBy: "explicit", score: 30 },
    { channelKey: "tt", platform: "tiktok", format: "tiktok", folderRef: "reels", folderPath: "Drive / Flerdvision / Reels", totalVideoCount: 2, matchedBy: "explicit", score: 30 }
  ]
};

test("same spec compiles to one shared lane and stable activation semantics", () => {
  const root = mkdtempSync(join(tmpdir(), "flerdvision-headless-compiler-"));
  const configDir = join(root, "config");
  const databaseDir = join(root, "database");
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  mkdirSync(databaseDir, { recursive: true, mode: 0o700 });
  const config = new JsonDistributionConfigurationStore(join(configDir, "distribution.json"));
  const control = new SqliteControlPlaneStore(join(databaseDir, "flerdvision.sqlite"));
  try {
    const compiler = new WorkspaceSpecCompiler(config, control, configDir);
    const first = compiler.compile(parsedSpec(), topology, "2026-08-27T10:00:00Z");
    const firstState = config.load();
    const second = compiler.compile(parsedSpec(), topology, "2026-08-28T10:00:00Z");
    const secondState = config.load();

    assert.equal(first.changed, true);
    assert.equal(second.changed, false);
    assert.equal(firstState.revision, secondState.revision);
    assert.equal(secondState.config.sources.length, 1);
    assert.equal(secondState.config.lanes.length, 1, "one source folder must feed both channels without duplicate per-account paths");
    assert.equal(secondState.config.routes.length, 2);
    assert.equal(secondState.config.activationCursors[0].activatedAt, "2026-08-27T10:00:00.000Z", "re-running bootstrap must not move the ingestion baseline");
    assert.equal(control.listSocialAccounts().length, 2);
    assert.equal(control.listBrowserIdentities().length, 2);
  } finally {
    control.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
  }
});
