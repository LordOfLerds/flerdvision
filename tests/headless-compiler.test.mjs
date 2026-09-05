import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonDistributionConfigurationStore } from "../dist/adapters/distribution/json-config-store.js";
import { SqliteControlPlaneStore } from "../dist/adapters/storage/sqlite.js";
import { WorkspaceSpecCompiler } from "../dist/application/workspace-spec-compiler.js";
import { parseWorkspaceSpec } from "../dist/domain/workspace-spec.js";

function parsedSpec(customerName = "Flerdvision Kunde") {
  return parseWorkspaceSpec({
    schemaVersion: 1,
    workspace: { id: "compiler", name: "Compiler" },
    source: { kind: "google_drive", root: "1AbCdEfGhIjKlMnOp", structure: "auto", activation: "IMPORT_BACKLOG" },
    customers: [{ key: "kunde", name: customerName }],
    channels: [
      { key: "ig", name: "Instagram", customerKey: "kunde", platform: "instagram", handle: "flerdvision", formats: [{ type: "reel", times: ["12:00", "19:00"], sourceMatch: ["reels"], verificationMarker: true }] },
      { key: "tt", name: "TikTok", customerKey: "kunde", platform: "tiktok", handle: "flerdvision", formats: [{ type: "tiktok", times: ["13:00", "20:00"], sourceMatch: ["reels"], verificationMarker: true }] }
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

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "flerdvision-headless-compiler-"));
  const configDir = join(root, "config");
  const databaseDir = join(root, "database");
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  mkdirSync(databaseDir, { recursive: true, mode: 0o700 });
  const config = new JsonDistributionConfigurationStore(join(configDir, "distribution.json"));
  const control = new SqliteControlPlaneStore(join(databaseDir, "flerdvision.sqlite"));
  return { root, configDir, config, control, close() { control.close(); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }); } };
}

test("same spec compiles to one shared lane and stable activation semantics", () => {
  const f = fixture();
  try {
    const compiler = new WorkspaceSpecCompiler(f.config, f.control, f.configDir);
    const first = compiler.compile(parsedSpec(), topology, "2026-08-27T10:00:00Z");
    const firstState = f.config.load();
    const second = compiler.compile(parsedSpec(), topology, "2026-08-28T10:00:00Z");
    const secondState = f.config.load();

    assert.equal(first.changed, true);
    assert.equal(second.changed, false);
    assert.equal(firstState.revision, secondState.revision);
    assert.equal(secondState.config.sources.length, 1);
    assert.equal(secondState.config.lanes.length, 1, "one source folder must feed both channels without duplicate per-account paths");
    assert.equal(secondState.config.routes.length, 2);
    assert.equal(secondState.config.activationCursors[0].activatedAt, "2026-08-27T10:00:00.000Z", "re-running bootstrap must not move the ingestion baseline");
    assert.equal(f.control.listSocialAccounts().length, 2);
    assert.equal(f.control.listBrowserIdentities().length, 2);
  } finally { f.close(); }
});

test("renaming a customer is business metadata only and cannot stale any platform identity", () => {
  const f = fixture();
  try {
    const compiler = new WorkspaceSpecCompiler(f.config, f.control, f.configDir);
    compiler.compile(parsedSpec("Kunde Alt"), topology, "2026-08-27T10:00:00Z");
    const before = f.config.load();
    const accountsBefore = f.control.listSocialAccounts().map((record) => record.account.accountId).sort();
    const identitiesBefore = f.control.listBrowserIdentities().map((record) => record.identity.identityId).sort();
    const routeIdsBefore = before.config.routes.map((route) => route.routeId).sort();
    const postingIdsBefore = before.config.postingProfiles.map((profile) => profile.postingProfileId).sort();
    const scheduleIdsBefore = Object.keys(before.schedulePolicies).sort();

    const result = compiler.compile(parsedSpec("Kunde Neu"), topology, "2026-08-28T10:00:00Z");
    const after = f.config.load();

    assert.equal(result.changed, false, "customer display metadata does not change executable distribution config");
    assert.equal(after.revision, before.revision);
    assert.deepEqual(after.config.routes.map((route) => route.routeId).sort(), routeIdsBefore);
    assert.deepEqual(after.config.postingProfiles.map((profile) => profile.postingProfileId).sort(), postingIdsBefore);
    assert.deepEqual(Object.keys(after.schedulePolicies).sort(), scheduleIdsBefore);
    assert.deepEqual(f.control.listSocialAccounts().map((record) => record.account.accountId).sort(), accountsBefore);
    assert.deepEqual(f.control.listBrowserIdentities().map((record) => record.identity.identityId).sort(), identitiesBefore);
  } finally { f.close(); }
});
