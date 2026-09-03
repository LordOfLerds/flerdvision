import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { findChromiumExecutable } from "../adapters/browser/resolve-chromium.js";
import { calibratedSessionProbeFor, loadSessionProbeConfigFile } from "../adapters/browser/session-probe-config.js";
import { JsonDistributionConfigurationStore } from "../adapters/distribution/json-config-store.js";
import { SqliteDistributionRuntimeStateStore } from "../adapters/distribution/sqlite-runtime-state.js";
import { SqlitePlatformSurfaceStore } from "../adapters/distribution/sqlite-surface-store.js";
import { SqliteRouteTestEvidenceStore } from "../adapters/distribution/sqlite-route-test-evidence.js";
import { FileDriveCredentialStore } from "../adapters/ingress/google-drive/drive-credentials.js";
import { resolveFfprobeExecutablePath } from "../adapters/media/resolve-ffprobe.js";
import { SqliteControlPlaneStore } from "../adapters/storage/sqlite.js";
import type { RouteTestEvidenceRecord } from "../domain/route-test-ports.js";
import { loadWorkspaceSpecFile } from "./headless-bootstrap.js";
import { germanReplayProgress, resolveQualificationReplays } from "./qualification-policy.js";
import { currentSurfaceFingerprintOrUndefined, describeSurfaceFingerprint, surfaceFingerprintMatches } from "./surface-fingerprint.js";
import { accountIdForChannel, identityIdForChannel } from "./workspace-spec-compiler.js";
import { workspaceRuntimeLayout } from "./workspaces.js";

export type DoctorStatus = "PASS" | "WARN" | "FAIL";
export interface DoctorCheck { key: string; status: DoctorStatus; detail: string; }
export interface HeadlessChannelStatus {
  channelKey: string;
  platform: string;
  accountId: string;
  identityId: string;
  accountRegistered: boolean;
  identityRegistered: boolean;
  latestSessionState: string;
  sessionProbeCalibrated: boolean;
  routes: readonly {
    routeId: string;
    format: string;
    readyAssets: number;
    surfaceStatus: string;
    prepareOnlyPasses: number;
    requiredPrepareOnlyPasses: number;
    prepareOnlyLabel: string;
    verificationPassed: boolean;
    /** Informational audit value only; a differing release SHA never blocks any more. */
    releaseMatches: boolean;
    qualifiedReleaseSha?: string;
    qualifiedSurfaceFingerprint?: string;
    surfaceFingerprintMatches: boolean;
    surfaceFingerprintLabel: string;
    privateE2EPassed: boolean;
    cleanupPassedAfterPrivateE2E: boolean;
    blockers: readonly string[];
    warnings: readonly string[];
    readyForAutonomousPublish: boolean;
  }[];
}
export interface HeadlessDoctorReport {
  schemaVersion: 1;
  checkedAt: string;
  workspaceId: string;
  ownerEmail: string;
  releaseSha: string;
  surfaceFingerprint?: string;
  checks: readonly DoctorCheck[];
  channels: readonly HeadlessChannelStatus[];
  overall: DoctorStatus;
}

function worst(statuses: readonly DoctorStatus[]): DoctorStatus {
  if (statuses.includes("FAIL")) return "FAIL";
  if (statuses.includes("WARN")) return "WARN";
  return "PASS";
}
function executableCheck(key: string, resolvePath: () => string | undefined): DoctorCheck {
  try {
    const path = resolvePath();
    return path ? { key, status: "PASS", detail: path } : { key, status: "FAIL", detail: `${key} executable not found` };
  } catch (error) {
    return { key, status: "FAIL", detail: error instanceof Error ? error.message : String(error) };
  }
}
function latestPass(records: readonly RouteTestEvidenceRecord[], key: RouteTestEvidenceRecord["testKey"]): RouteTestEvidenceRecord | undefined {
  return records.filter((record) => record.testKey === key && record.status === "PASS").sort((a, b) => a.checkedAt.localeCompare(b.checkedAt)).at(-1);
}

export function inspectHeadlessWorkspace(input: {
  specPath: string;
  releaseSha: string;
  env?: Record<string, string | undefined>;
  now?: string;
}): HeadlessDoctorReport {
  const spec = loadWorkspaceSpecFile(input.specPath);
  const env = input.env ?? process.env;
  const checkedAt = new Date(input.now ?? new Date().toISOString()).toISOString();
  const runtimeRoot = resolve(spec.workspace.runtimeRoot);
  const layout = workspaceRuntimeLayout(runtimeRoot, spec.workspace.id);
  const checks: DoctorCheck[] = [];
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push({ key: "node", status: Number.isInteger(nodeMajor) && nodeMajor >= 22 ? "PASS" : "FAIL", detail: `node=${process.versions.node}; required>=22` });
  const actualTimeZone = env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  checks.push({ key: "timezone", status: actualTimeZone === spec.workspace.timezone ? "PASS" : "FAIL", detail: `actual=${actualTimeZone}; expected=${spec.workspace.timezone}` });
  checks.push(executableCheck("chromium", () => findChromiumExecutable(env)));
  checks.push(executableCheck("ffprobe", () => resolveFfprobeExecutablePath(env.FFPROBE_EXECUTABLE_PATH)));
  checks.push({ key: "workspace_runtime", status: existsSync(layout.workspaceRoot) ? "PASS" : "FAIL", detail: layout.workspaceRoot });
  checks.push({ key: "database", status: existsSync(layout.databasePath) ? "PASS" : "FAIL", detail: layout.databasePath });
  checks.push({ key: "distribution_config", status: existsSync(resolve(layout.configDir, "distribution.json")) ? "PASS" : "FAIL", detail: resolve(layout.configDir, "distribution.json") });
  checks.push({ key: "release_sha", status: input.releaseSha.trim() !== "" && input.releaseSha !== "UNSET_RELEASE_SHA" ? "PASS" : "FAIL", detail: input.releaseSha || "missing" });
  // Qualification is bound to the surface code, not to the release: this is the value every
  // readiness decision below compares against.
  const currentFingerprint = currentSurfaceFingerprintOrUndefined();
  const requiredReplays = resolveQualificationReplays(env);
  checks.push({
    key: "surface_fingerprint",
    status: currentFingerprint ? "PASS" : "FAIL",
    detail: currentFingerprint ? `Oberflächen-Fingerabdruck ${describeSurfaceFingerprint(currentFingerprint)} · Release ${input.releaseSha || "unbekannt"}` : "Oberflächen-Fingerabdruck nicht lesbar; zuerst bauen"
  });
  if (spec.source.kind === "google_drive") {
    const credential = existsSync(layout.configDir) ? new FileDriveCredentialStore(layout.configDir).read() : null;
    checks.push({ key: "drive_auth", status: credential ? "PASS" : "FAIL", detail: credential ? `connected ${credential.connectedAt}` : "Run drive-auth for this workspace" });
  } else checks.push({ key: "local_source", status: existsSync(resolve(spec.source.root)) ? "PASS" : "FAIL", detail: resolve(spec.source.root) });

  if (!existsSync(layout.databasePath) || !existsSync(resolve(layout.configDir, "distribution.json"))) {
    return { schemaVersion: 1, checkedAt, workspaceId: spec.workspace.id, ownerEmail: spec.workspace.ownerEmail, releaseSha: input.releaseSha, ...(currentFingerprint ? { surfaceFingerprint: currentFingerprint } : {}), checks, channels: [], overall: worst(checks.map((check) => check.status)) };
  }

  const config = new JsonDistributionConfigurationStore(resolve(layout.configDir, "distribution.json")).load();
  const control = new SqliteControlPlaneStore(layout.databasePath);
  const runtime = new SqliteDistributionRuntimeStateStore(layout.databasePath);
  const surfaces = new SqlitePlatformSurfaceStore(layout.databasePath);
  const routeEvidence = new SqliteRouteTestEvidenceStore(layout.databasePath);
  try {
    const probePath = resolve(layout.configDir, "session-probes.json");
    const probes = existsSync(probePath) ? loadSessionProbeConfigFile(probePath) : { schemaVersion: 1 as const, probes: [] };
    const assets = runtime.listAssets();
    const channels: HeadlessChannelStatus[] = spec.channels.map((channel) => {
      const accountId = accountIdForChannel(channel);
      const identityId = identityIdForChannel(channel);
      const account = control.getSocialAccount(accountId)?.account;
      const identity = control.getBrowserIdentity(identityId)?.identity;
      const health = identity ? control.latestSessionHealth(identityId) : null;
      const sessionProbeCalibrated = Boolean(calibratedSessionProbeFor(probes, accountId, channel.platform));
      const routeRows = config.config.routes.filter((route) => route.accountId === accountId).map((route) => {
        const profile = config.config.postingProfiles.find((item) => item.postingProfileId === route.postingProfileId);
        const readiness = runtime.latestRouteTestReadiness(route.routeId)?.readiness;
        const surface = surfaces.latestContract(accountId, route.postingProfileId)?.contract;
        const readyAssets = assets.filter((item) => item.asset.laneId === route.laneId && item.asset.state === "READY").length;
        const releaseMatches = readiness?.releaseSha === input.releaseSha;
        const fingerprintMatches = surfaceFingerprintMatches(readiness?.surfaceFingerprint, currentFingerprint);
        const records = routeEvidence.list(route.routeId).filter((record) =>
          surfaceFingerprintMatches(record.surfaceFingerprint, currentFingerprint) &&
          Boolean(surface) &&
          record.surfaceContractId === surface!.contractId
        );
        const privateE2E = latestPass(records, "SECRET_LIVE");
        const cleanup = latestPass(records, "CLEANUP");
        const privateE2EPassed = Boolean(privateE2E);
        const cleanupPassedAfterPrivateE2E = Boolean(cleanup && privateE2E && cleanup.checkedAt > privateE2E.checkedAt);
        const blockers: string[] = [];
        if (!route.enabled) blockers.push("route_disabled");
        if (!account?.enabled) blockers.push("account_missing_or_disabled");
        if (!identity?.enabled) blockers.push("identity_missing_or_disabled");
        if (health?.state !== "HEALTHY") blockers.push("session_not_healthy");
        if (!sessionProbeCalibrated) blockers.push("session_probe_not_calibrated");
        if (readyAssets < 1) blockers.push("no_ready_asset");
        if (!surface || surface.status !== "CALIBRATED") blockers.push("surface_not_calibrated");
        if (!readiness) blockers.push("route_readiness_missing");
        else {
          // The release SHA is audit information only. Blocking on it invalidated every channel
          // on commits that cannot change what the browser sees; the surface fingerprint is the
          // value that actually decides whether a qualification still describes reality.
          if (!fingerprintMatches) blockers.push("surface_fingerprint_stale");
          if (!readiness.sourcePassed) blockers.push("source_not_proven");
          if (!readiness.sessionPassed) blockers.push("session_not_proven");
          if (!readiness.identityPassed) blockers.push("identity_not_proven");
          if (readiness.prepareOnlyPasses < requiredReplays) blockers.push("prepare_only_replays_missing");
          if (!readiness.verificationPassed) blockers.push("verification_surface_not_proven");
          if (surface && readiness.surfaceContractId !== surface.contractId) blockers.push("surface_evidence_stale");
        }
        // Operator decision 2026-09-03: the first scheduled slot is the first post, so a private
        // test post is no longer a gate for autonomous publishing. It stays reported as a warning
        // for whoever wants to run it.
        const warnings: string[] = [];
        if (!privateE2EPassed || !cleanupPassedAfterPrivateE2E) warnings.push("private_e2e_not_run");
        return {
          routeId: route.routeId,
          format: profile?.format ?? "unknown",
          readyAssets,
          surfaceStatus: surface?.status ?? "MISSING",
          prepareOnlyPasses: readiness?.prepareOnlyPasses ?? 0,
          requiredPrepareOnlyPasses: requiredReplays,
          prepareOnlyLabel: germanReplayProgress(readiness?.prepareOnlyPasses ?? 0, requiredReplays),
          verificationPassed: readiness?.verificationPassed ?? false,
          releaseMatches,
          ...(readiness?.releaseSha ? { qualifiedReleaseSha: readiness.releaseSha } : {}),
          ...(readiness?.surfaceFingerprint ? { qualifiedSurfaceFingerprint: readiness.surfaceFingerprint } : {}),
          surfaceFingerprintMatches: fingerprintMatches,
          surfaceFingerprintLabel: `Oberflächen-Fingerabdruck ${readiness?.surfaceFingerprint ? describeSurfaceFingerprint(readiness.surfaceFingerprint) : "fehlt"}: ${fingerprintMatches ? "passt" : "veraltet"}${fingerprintMatches ? "" : ` (aktuell ${currentFingerprint ? describeSurfaceFingerprint(currentFingerprint) : "unbekannt"})`}`,
          privateE2EPassed,
          cleanupPassedAfterPrivateE2E,
          blockers,
          warnings,
          readyForAutonomousPublish: blockers.length === 0
        };
      });
      return {
        channelKey: channel.key,
        platform: channel.platform,
        accountId,
        identityId,
        accountRegistered: Boolean(account),
        identityRegistered: Boolean(identity),
        latestSessionState: health?.state ?? "MISSING",
        sessionProbeCalibrated,
        routes: routeRows
      };
    });
    for (const channel of channels) {
      const ready = channel.routes.filter((route) => route.readyForAutonomousPublish).length;
      checks.push({
        key: `channel:${channel.channelKey}`,
        status: channel.routes.length > 0 && ready === channel.routes.length ? "PASS" : channel.accountRegistered && channel.identityRegistered ? "WARN" : "FAIL",
        detail: `${channel.latestSessionState}; ${ready}/${channel.routes.length} routes autonomous-ready${ready === channel.routes.length ? "" : `; blockers=${[...new Set(channel.routes.flatMap((route) => route.blockers))].join(",")}`}${(() => { const warnings = [...new Set(channel.routes.flatMap((route) => route.warnings))]; return warnings.length > 0 ? `; warnings=${warnings.join(",")}` : ""; })()}`
      });
    }
    return { schemaVersion: 1, checkedAt, workspaceId: spec.workspace.id, ownerEmail: spec.workspace.ownerEmail, releaseSha: input.releaseSha, ...(currentFingerprint ? { surfaceFingerprint: currentFingerprint } : {}), checks, channels, overall: worst(checks.map((check) => check.status)) };
  } finally {
    routeEvidence.close();
    surfaces.close();
    runtime.close();
    control.close();
  }
}
