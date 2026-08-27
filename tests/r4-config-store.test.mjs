import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JsonDistributionConfigurationStore, DistributionConfigurationRevisionConflict } from "../dist/adapters/distribution/json-config-store.js";
import { DistributionManagementService } from "../dist/application/distribution-management.js";

function store() {
  const root = mkdtempSync(join(tmpdir(), "flerdvision-distribution-"));
  const path = join(root, "config", "distribution.json");
  return { path, value: new JsonDistributionConfigurationStore(path) };
}

test("distribution config is private, revisioned and rejects stale writes", () => {
  const { path, value } = store();
  const first = value.load();
  assert.equal(first.revision, 0);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const saved = value.save({ ...first, updatedAt: "2026-08-27T07:00:00.000Z" }, 0);
  assert.equal(saved.revision, 1);
  assert.throws(() => value.save({ ...saved, updatedAt: "2026-08-27T07:01:00.000Z" }, 0), DistributionConfigurationRevisionConflict);
});

test("management service builds source -> lane -> profiles -> route and returns impact on later changes", () => {
  const { value } = store();
  const service = new DistributionManagementService(value);
  let rev = 0;
  rev = service.saveSource({ connectionId: "src", displayName: "Drive", kind: "google_drive", rootRef: "root", enabled: true, disposition: { mode: "database_only", leavePartialUntouched: true, leaveBlockedUntouched: true } }, rev, "2026-08-27T07:00:00.000Z").stored.revision;
  rev = service.saveLane({ laneId: "lane", connectionId: "src", displayName: "Piet", folderRef: "f", folderPath: "Piet", interpretation: { kind: "flat" }, enabled: true }, rev, "2026-08-27T07:01:00.000Z").stored.revision;
  rev = service.savePostingProfile({ postingProfileId: "ig", displayName: "IG Normal", platform: "instagram", format: "reel", commentsEnabled: true, shareToFeed: true, crosspostFacebook: false, enabled: true }, rev, "2026-08-27T07:02:00.000Z").stored.revision;
  rev = service.saveCopyProfile({ copyProfileId: "copy", displayName: "Copy", versionId: "v1", strategy: "template", enabled: true }, rev, "2026-08-27T07:03:00.000Z").stored.revision;
  rev = service.saveRoute({ routeId: "r1", displayName: "Piet IG", laneId: "lane", accountId: "ig1", platform: "instagram", postingProfileId: "ig", copyProfileId: "copy", schedulePolicyId: "default", requirement: "REQUIRED", enabled: true }, rev, "2026-08-27T07:04:00.000Z").stored.revision;

  const changed = service.savePostingProfile({ postingProfileId: "ig", displayName: "IG Trial", platform: "instagram", format: "trial_reel", commentsEnabled: true, shareToFeed: false, crosspostFacebook: false, enabled: true }, rev, "2026-08-27T07:05:00.000Z");
  assert.deepEqual(changed.impact.affectedRouteIds, ["r1"]);
  assert.equal(changed.impact.requireRouteRetest, true);
  assert.equal(changed.stored.config.routes[0].routeId, "r1");
});

test("store rejects orphan route before writing it", () => {
  const { value } = store();
  const current = value.load();
  assert.throws(() => value.save({
    ...current,
    updatedAt: "2026-08-27T07:00:00.000Z",
    config: { ...current.config, routes: [{ routeId: "bad", displayName: "Bad", laneId: "missing", accountId: "ig", platform: "instagram", postingProfileId: "missing", copyProfileId: "missing", schedulePolicyId: "default", requirement: "REQUIRED", enabled: true }] }
  }, 0), /missing lane/);
  assert.equal(value.load().revision, 0);
});
