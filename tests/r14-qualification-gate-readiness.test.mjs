import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { JsonDistributionConfigurationStore } from "../dist/adapters/distribution/json-config-store.js";
import { SqliteDistributionRuntimeStateStore } from "../dist/adapters/distribution/sqlite-runtime-state.js";
import { SqliteRouteTestEvidenceStore } from "../dist/adapters/distribution/sqlite-route-test-evidence.js";
import { SqlitePlatformSurfaceStore } from "../dist/adapters/distribution/sqlite-surface-store.js";
import { SqliteControlPlaneStore } from "../dist/adapters/storage/sqlite.js";
import { inspectHeadlessWorkspace } from "../dist/application/headless-status.js";
import { germanBlocker, germanDoctorCheck } from "../dist/application/operator-message.js";
import { computeSurfaceFingerprint, describeSurfaceFingerprint } from "../dist/application/surface-fingerprint.js";
import { WorkspaceSpecCompiler } from "../dist/application/workspace-spec-compiler.js";
import { workspaceRuntimeLayout } from "../dist/application/workspaces.js";
import { parseWorkspaceSpec } from "../dist/domain/workspace-spec.js";

const SURFACE = computeSurfaceFingerprint();
const CONTRACT_ID = "surface:doctor-contract";

function specJson(runtimeRoot, sourceRoot) {
  return {
    schemaVersion: 1,
    workspace: { id: "doctor", name: "Doctor", ownerEmail: "info@flerdvision.com", timezone: "Europe/Vienna", runtimeRoot },
    source: { kind: "local_folder", root: sourceRoot, structure: "auto", activation: "NEW_ONLY", maxDepth: 4 },
    channels: [{ key: "tt", name: "TikTok", platform: "tiktok", handle: "flerdvision", formats: [{ type: "tiktok", times: ["12:00"], sourceMatch: ["clips"], verificationMarker: false }] }]
  };
}

function topologyFor(spec) {
  return {
    rootId: "root", rootPath: "Local / Flerdvision", verified: true, warnings: [],
    nodes: [{ folderId: "clips", folderRef: "clips", folderPath: "Local / Clips", name: "Clips", depth: 1, directVideoCount: 1, totalVideoCount: 1, childFolderCount: 0 }],
    streams: spec.channels.map((channel) => ({ channelKey: channel.key, platform: channel.platform, format: channel.formats[0].type, folderRef: "clips", folderPath: "Local / Clips", totalVideoCount: 1, matchedBy: "explicit", score: 30 }))
  };
}

/** A workspace whose only open question is whether the recorded qualification is still current. */
function workspace(readinessOverrides = {}, privateE2E = false) {
  const root = mkdtempSync(join(tmpdir(), "flerdvision-doctor-"));
  const runtimeRoot = join(root, "runtime");
  const sourceRoot = join(root, "source");
  mkdirSync(sourceRoot, { recursive: true, mode: 0o700 });
  const specPath = join(root, "flerdvision.json");
  const raw = specJson(runtimeRoot, sourceRoot);
  writeFileSync(specPath, JSON.stringify(raw, null, 2), "utf8");
  const spec = parseWorkspaceSpec(raw);
  const layout = workspaceRuntimeLayout(runtimeRoot, spec.workspace.id);
  for (const dir of [layout.workspaceRoot, layout.configDir, join(layout.workspaceRoot, "database")]) mkdirSync(dir, { recursive: true, mode: 0o700 });

  const config = new JsonDistributionConfigurationStore(resolve(layout.configDir, "distribution.json"));
  const control = new SqliteControlPlaneStore(layout.databasePath);
  const compiled = new WorkspaceSpecCompiler(config, control, layout.configDir).compile(spec, topologyFor(spec), "2026-09-03T06:00:00.000Z", { type: "operator", id: "test" });
  const route = config.load().config.routes[0];
  const identityId = control.listBrowserIdentities()[0].identity.identityId;
  control.recordSessionHealth({ checkId: "health:doctor", identityId, checkedAt: "2026-09-03T06:30:00.000Z", state: "HEALTHY", expectedHandle: "flerdvision", observedHandle: "flerdvision" }, { type: "operator", id: "test" });
  control.close();
  void compiled;

  // Everything that is not the qualification itself is seeded green, so a blocker in these tests
  // can only come from the fingerprint/replay decision under test.
  writeFileSync(resolve(layout.configDir, "session-probes.json"), JSON.stringify({
    schemaVersion: 1,
    probes: [{ probeId: "tt-doctor", platform: "tiktok", accountId: route.accountId, calibrationStatus: "CALIBRATED", calibratedAt: "2026-09-03T06:00:10.000Z", calibratedBy: "test", config: { probeUrl: "https://www.tiktok.com/", identitySelector: "[data-e2e=nav-profile]", authUrlIncludes: ["/login"], challengeUrlIncludes: ["/verify"], settleMs: 1000 } }]
  }, null, 2), "utf8");
  const surfaces = new SqlitePlatformSurfaceStore(layout.databasePath);
  surfaces.recordContract({
    contractId: CONTRACT_ID, accountId: route.accountId, platform: route.platform, format: "tiktok", postingProfileId: route.postingProfileId,
    environment: { browserFamily: "chromium", browserMajor: 140, language: "de-AT", timeZone: "Europe/Vienna", viewportWidth: 1280, viewportHeight: 900, deviceScaleFactor: 1, fingerprint: "env" },
    steps: [], status: "CALIBRATED", createdAt: "2026-09-03T06:00:00.000Z", calibratedAt: "2026-09-03T06:00:00.000Z"
  }, "2026-09-03T06:00:00.000Z");
  surfaces.close();

  const state = new SqliteDistributionRuntimeStateStore(layout.databasePath);
  state.putAsset({
    assetId: "asset-1", contentId: "content-1", laneId: route.laneId, creatorId: "creator", sourceObservationId: "obs-1",
    sourceRef: "local://clips/01.mp4", externalObjectId: "01.mp4", filename: "01 Clip.mp4", mediaFingerprint: "fp-1",
    observedAt: "2026-09-03T06:00:30.000Z", state: "READY", readyAt: "2026-09-03T06:00:40.000Z", metadata: {}
  }, "2026-09-03T06:00:40.000Z");
  state.putRouteTestReadiness({
    routeId: route.routeId, sourcePassed: true, sessionPassed: true, identityPassed: true, prepareOnlyPasses: 1,
    secretLivePassed: false, verificationPassed: true, cleanupPassed: false,
    releaseSha: "release-of-the-qualification", surfaceFingerprint: SURFACE, surfaceContractId: CONTRACT_ID,
    ...readinessOverrides
  }, "2026-09-03T06:01:00.000Z");
  state.close();

  if (privateE2E) {
    const evidence = new SqliteRouteTestEvidenceStore(layout.databasePath);
    for (const [testKey, checkedAt] of [["SECRET_LIVE", "2026-09-03T06:30:00.000Z"], ["CLEANUP", "2026-09-03T06:40:00.000Z"]]) {
      evidence.record({ evidenceId: `route-test:${testKey}`, routeId: route.routeId, testKey, status: "PASS", checkedAt, releaseSha: "release-of-the-qualification", surfaceFingerprint: SURFACE, surfaceContractId: CONTRACT_ID, summary: `${testKey} proven`, artifactRefs: [`evidence://${testKey}`] });
    }
    evidence.close();
  }

  return { specPath, routeId: route.routeId };
}

function routeRow(readinessOverrides = {}, releaseSha = "a-much-later-release", privateE2E = false) {
  const { specPath } = workspace(readinessOverrides, privateE2E);
  const report = inspectHeadlessWorkspace({ specPath, releaseSha, env: { TZ: "Europe/Vienna" }, now: "2026-09-03T07:00:00.000Z" });
  return { report, route: report.channels[0].routes[0] };
}

test("a matching surface fingerprint and one replay keep the route qualified", () => {
  const { route } = routeRow();
  assert.equal(route.surfaceFingerprintMatches, true);
  assert.equal(route.blockers.includes("surface_fingerprint_stale"), false);
  assert.equal(route.blockers.includes("prepare_only_replays_missing"), false);
  assert.equal(route.requiredPrepareOnlyPasses, 1);
  assert.equal(route.prepareOnlyLabel, "1/1 Trockenlauf");
});

test("a release SHA that no longer matches does not block on its own", () => {
  const { route } = routeRow();
  assert.equal(route.releaseMatches, false, "the doctor still reports the release for the audit trail");
  assert.equal(route.qualifiedReleaseSha, "release-of-the-qualification");
  assert.equal(route.blockers.includes("route_release_stale"), false);
  assert.equal(route.blockers.includes("route_test_release_sha_stale_or_missing"), false);
  assert.equal(route.blockers.length, 0, `unexpected blockers: ${route.blockers.join(",")}`);
  assert.equal(route.readyForAutonomousPublish, true);
});

test("a changed surface fingerprint blocks, and so does evidence recorded before fingerprints existed", () => {
  const changed = routeRow({ surfaceFingerprint: "a".repeat(64) }).route;
  assert.equal(changed.surfaceFingerprintMatches, false);
  assert.ok(changed.blockers.includes("surface_fingerprint_stale"));
  assert.equal(changed.readyForAutonomousPublish, false);

  const legacy = routeRow({ surfaceFingerprint: undefined }).route;
  assert.ok(legacy.blockers.includes("surface_fingerprint_stale"));
});

test("too few prepare-only replays still block", () => {
  const { route } = routeRow({ prepareOnlyPasses: 0 });
  assert.ok(route.blockers.includes("prepare_only_replays_missing"));
  assert.equal(route.prepareOnlyLabel, "0/1 Trockenlauf");
});

test("a missing private E2E is a warning, not a gate", () => {
  const { route } = routeRow();
  assert.equal(route.privateE2EPassed, false);
  assert.equal(route.cleanupPassedAfterPrivateE2E, false);
  assert.deepEqual([...route.warnings], ["private_e2e_not_run"]);
  assert.equal(route.blockers.includes("private_e2e_missing"), false);
  assert.equal(route.blockers.includes("private_e2e_cleanup_missing_or_stale"), false);
  assert.equal(route.readyForAutonomousPublish, true, "the first scheduled slot is the first post");

  // Whoever does run it must still see it: the doctor reads private E2E evidence back under the
  // surface fingerprint, exactly like every other route test.
  const withPost = routeRow({}, "a-much-later-release", true).route;
  assert.equal(withPost.privateE2EPassed, true);
  assert.equal(withPost.cleanupPassedAfterPrivateE2E, true);
  assert.deepEqual([...withPost.warnings], []);
});

test("the doctor reports both values in German", () => {
  const { report, route } = routeRow();
  assert.equal(report.surfaceFingerprint, SURFACE);
  const check = report.checks.find((item) => item.key === "surface_fingerprint");
  assert.equal(check.status, "PASS");
  assert.match(check.detail, /^Oberflächen-Fingerabdruck [0-9a-f]{12} · Release a-much-later-release$/);
  assert.equal(route.surfaceFingerprintLabel, `Oberflächen-Fingerabdruck ${describeSurfaceFingerprint(SURFACE)}: passt`);
  assert.match(routeRow({ surfaceFingerprint: "b".repeat(64) }).route.surfaceFingerprintLabel, /: veraltet \(aktuell [0-9a-f]{12}\)$/);
  assert.equal(germanDoctorCheck("surface_fingerprint"), "Oberflächen-Fingerabdruck");
  assert.equal(germanBlocker("surface_fingerprint_stale"), "Oberflächen-Fingerabdruck veraltet");
  assert.equal(germanBlocker("prepare_only_replays_missing"), "zu wenige Trockenläufe");
  assert.equal(germanBlocker("private_e2e_not_run"), "privater Testpost nicht gelaufen");
});
