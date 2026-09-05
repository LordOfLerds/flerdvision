import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { SqliteControlPlaneStore } from "../adapters/storage/sqlite.js";
import type { Platform } from "../domain/model.js";
import { loadWorkspaceSpecFile } from "./headless-bootstrap.js";
import { HeadlessOnboardingService } from "./headless-onboarding.js";
import { inspectHeadlessWorkspace } from "./headless-status.js";
import { currentSurfaceFingerprintOrUndefined } from "./surface-fingerprint.js";
import { accountIdForChannel } from "./workspace-spec-compiler.js";
import { workspaceRuntimeLayout } from "./workspaces.js";

interface PersistedAcceptanceCandidate {
  schemaVersion: 1;
  releaseSha: string;
  surfaceFingerprint: string;
  specDigest: string;
  frozenAt: string;
}

export interface AcceptancePlatformStatus {
  platform: Platform;
  configured: boolean;
  verified: number;
  uncertain: number;
  blocked: number;
  pending: number;
}

export interface AcceptanceCandidateStatus {
  frozen: boolean;
  current: boolean;
  releaseSha?: string;
  currentReleaseSha: string;
  surfaceMatches: boolean;
  specMatches: boolean;
  onboardingReady: boolean;
  routesPrepared: boolean;
  platforms: readonly AcceptancePlatformStatus[];
  readyToRun: boolean;
  frozenAt?: string;
  reason?: string;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function specDigest(specPath: string): string {
  return digest(JSON.stringify(loadWorkspaceSpecFile(specPath)));
}

function candidatePath(specPath: string): string {
  const spec = loadWorkspaceSpecFile(specPath);
  const layout = workspaceRuntimeLayout(resolve(spec.workspace.runtimeRoot), spec.workspace.id);
  return resolve(layout.configDir, "acceptance-candidate.json");
}

function readCandidate(specPath: string): PersistedAcceptanceCandidate | undefined {
  const path = candidatePath(specPath);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as PersistedAcceptanceCandidate;
    if (parsed?.schemaVersion !== 1 || !parsed.releaseSha || !parsed.surfaceFingerprint || !parsed.specDigest) return undefined;
    return parsed;
  } catch { return undefined; }
}

function writeCandidate(specPath: string, candidate: PersistedAcceptanceCandidate): void {
  const path = candidatePath(specPath);
  const temp = `${path}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(temp, `${JSON.stringify(candidate, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temp, path);
}

function routePreparationReady(report: ReturnType<typeof inspectHeadlessWorkspace>): boolean {
  return report.channels.length > 0 && report.channels.every((channel) =>
    channel.routes.length > 0 && channel.routes.every((route) => route.blockers.every((blocker) => blocker === "no_ready_asset"))
  );
}

function platformStatus(specPath: string): readonly AcceptancePlatformStatus[] {
  const spec = loadWorkspaceSpecFile(specPath);
  const accountPlatform = new Map(spec.channels.map((channel) => [accountIdForChannel(channel), channel.platform]));
  const configured = new Set(spec.channels.map((channel) => channel.platform));
  const layout = workspaceRuntimeLayout(resolve(spec.workspace.runtimeRoot), spec.workspace.id);
  if (!existsSync(layout.databasePath)) {
    return (["instagram", "tiktok", "youtube"] as const).map((platform) => ({ platform, configured: configured.has(platform), verified: 0, uncertain: 0, blocked: 0, pending: 0 }));
  }
  const control = new SqliteControlPlaneStore(layout.databasePath);
  try {
    const testIntentIds = new Set(control.listReservations().filter((reservation) => reservation.slotKey.startsWith("test-now:")).map((reservation) => reservation.intentId));
    return (["instagram", "tiktok", "youtube"] as const).map((platform) => {
      const intents = control.listIntents().filter((record) => testIntentIds.has(record.intent.intentId) && accountPlatform.get(record.intent.accountId) === platform);
      return {
        platform,
        configured: configured.has(platform),
        verified: intents.filter((record) => record.state === "VERIFIED").length,
        uncertain: intents.filter((record) => record.state === "PUBLISH_UNCERTAIN").length,
        blocked: intents.filter((record) => record.state === "BLOCKED").length,
        pending: intents.filter((record) => !["VERIFIED", "PUBLISH_UNCERTAIN", "BLOCKED", "WAIVED"].includes(record.state)).length
      };
    });
  } finally { control.close(); }
}

function acceptanceRole(env: Record<string, string | undefined>): boolean {
  return env.FLERDVISION_WORKSPACE_ROLE?.trim().toLocaleLowerCase("en-US") === "acceptance";
}

/**
 * Freezes the code/spec/surface triple used by Luca acceptance. A test-now command may execute only
 * while this triple is still current; any code/spec drift requires a new explicit freeze.
 */
export class AcceptanceCandidateService {
  constructor(private readonly input: { specPath: string; releaseSha: string; env?: Record<string, string | undefined> }) {}

  private get env(): Record<string, string | undefined> { return this.input.env ?? process.env; }

  async freeze(now = new Date().toISOString()): Promise<AcceptanceCandidateStatus> {
    if (!acceptanceRole(this.env)) throw new Error("Acceptance candidate kann nur mit FLERDVISION_WORKSPACE_ROLE=acceptance eingefroren werden.");
    if (!this.input.releaseSha.trim() || this.input.releaseSha === "ONBOARDING_SETUP") throw new Error("Acceptance candidate braucht einen exakten Release-SHA.");
    const onboarding = await new HeadlessOnboardingService({ specPath: this.input.specPath, releaseSha: this.input.releaseSha, env: this.env }).status(now);
    if (!onboarding.ready) throw new Error(`Setup ist noch nicht READY: ${onboarding.nextAction ?? onboarding.stage}`);
    const doctor = inspectHeadlessWorkspace({ specPath: this.input.specPath, releaseSha: this.input.releaseSha, env: this.env, now });
    if (!routePreparationReady(doctor)) throw new Error("Mindestens eine Route ist vor Acceptance noch nicht vorbereitet/qualifiziert.");
    const surfaceFingerprint = currentSurfaceFingerprintOrUndefined();
    if (!surfaceFingerprint) throw new Error("Aktueller Surface-Fingerprint ist nicht lesbar; Release zuerst bauen.");
    writeCandidate(this.input.specPath, {
      schemaVersion: 1,
      releaseSha: this.input.releaseSha,
      surfaceFingerprint,
      specDigest: specDigest(this.input.specPath),
      frozenAt: new Date(now).toISOString()
    });
    return await this.status();
  }

  async status(): Promise<AcceptanceCandidateStatus> {
    const candidate = readCandidate(this.input.specPath);
    const surface = currentSurfaceFingerprintOrUndefined();
    const currentSpecDigest = specDigest(this.input.specPath);
    const onboarding = await new HeadlessOnboardingService({ specPath: this.input.specPath, releaseSha: this.input.releaseSha || "ACCEPTANCE_STATUS", env: this.env }).status();
    const doctor = inspectHeadlessWorkspace({ specPath: this.input.specPath, releaseSha: this.input.releaseSha || "ACCEPTANCE_STATUS", env: this.env });
    const routesPrepared = routePreparationReady(doctor);
    const platforms = platformStatus(this.input.specPath);
    const surfaceMatches = Boolean(candidate && surface && candidate.surfaceFingerprint === surface);
    const specMatches = Boolean(candidate && candidate.specDigest === currentSpecDigest);
    const releaseMatches = Boolean(candidate && candidate.releaseSha === this.input.releaseSha);
    const current = Boolean(candidate && surfaceMatches && specMatches && releaseMatches);
    const required = platforms.filter((item) => item.configured);
    const noUnsafe = required.every((item) => item.uncertain === 0);
    const allVerified = required.length > 0 && required.every((item) => item.verified > 0);
    const readyToRun = Boolean(current && onboarding.ready && routesPrepared && noUnsafe);
    let reason: string | undefined;
    if (!candidate) reason = "Noch kein Acceptance-Candidate eingefroren.";
    else if (!releaseMatches) reason = "Release-SHA weicht vom eingefrorenen Candidate ab.";
    else if (!surfaceMatches) reason = "Surface-Fingerprint hat sich seit dem Freeze geändert.";
    else if (!specMatches) reason = "Canonical Spec hat sich seit dem Freeze geändert.";
    else if (!onboarding.ready) reason = `Setup ist nicht READY: ${onboarding.nextAction ?? onboarding.stage}`;
    else if (!routesPrepared) reason = "Mindestens eine Route ist noch nicht vorbereitet.";
    else if (!noUnsafe) reason = "Mindestens ein Acceptance-Test ist PUBLISH_UNCERTAIN; zuerst verifizieren.";
    else if (allVerified) reason = "Alle konfigurierten Plattformen haben mindestens einen verifizierten test-now.";
    return {
      frozen: Boolean(candidate),
      current,
      ...(candidate ? { releaseSha: candidate.releaseSha, frozenAt: candidate.frozenAt } : {}),
      currentReleaseSha: this.input.releaseSha,
      surfaceMatches,
      specMatches,
      onboardingReady: onboarding.ready,
      routesPrepared,
      platforms,
      readyToRun,
      ...(reason ? { reason } : {})
    };
  }

  assertCurrent(): PersistedAcceptanceCandidate {
    if (!acceptanceRole(this.env)) throw new Error("Acceptance candidate gate is disabled outside an acceptance installation.");
    const candidate = readCandidate(this.input.specPath);
    if (!candidate) throw new Error("Kein Acceptance-Candidate eingefroren. Zuerst: flerdvision acceptance freeze");
    if (candidate.releaseSha !== this.input.releaseSha) throw new Error("test-now verweigert: aktueller Release-SHA weicht vom eingefrorenen Acceptance-Candidate ab.");
    const surface = currentSurfaceFingerprintOrUndefined();
    if (!surface || candidate.surfaceFingerprint !== surface) throw new Error("test-now verweigert: Surface-Fingerprint hat sich seit dem Acceptance-Freeze geändert.");
    if (candidate.specDigest !== specDigest(this.input.specPath)) throw new Error("test-now verweigert: Canonical Spec hat sich seit dem Acceptance-Freeze geändert.");
    return candidate;
  }
}
