import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { bootstrapHeadlessWorkspace } from "./headless-bootstrap.js";
import { ensureHeadlessLogin } from "./headless-login.js";
import { AutonomousRouteQualifier, type AutonomousRouteQualificationResult } from "./autonomous-surface-qualification.js";
import { accountIdForChannel } from "./workspace-spec-compiler.js";
import { workspaceRuntimeLayout } from "./workspaces.js";
import { calibratedSessionProbeFor, loadSessionProbeConfigFile } from "../adapters/browser/session-probe-config.js";
import { JsonDistributionConfigurationStore } from "../adapters/distribution/json-config-store.js";
import { WorkspaceDistributionRuntime } from "../adapters/runtime/workspace-distribution-runtime.js";
import { WorkspacePrivateE2ECommands } from "../adapters/runtime/workspace-private-e2e.js";

export type HeadlessDemoStage = "BOOTSTRAP" | "LOGIN" | "INGEST_PLAN" | "QUALIFY" | "SCHEDULE" | "PRIVATE_PUBLISH" | "REPORT";
export interface HeadlessDemoStageResult { stage: HeadlessDemoStage; status: "PASS" | "FAIL" | "SKIPPED"; summary: string; }
export interface HeadlessPrivatePublishResult { runId: string; intentId: string; accountId: string; finalAction: string; verification: string; cleanupRequired: true; }
export interface HeadlessDemoReport {
  schemaVersion: 1;
  runId: string;
  startedAt: string;
  finishedAt: string;
  releaseSha: string;
  workspaceId: string;
  ownerEmail: string;
  businessDate: string;
  stages: readonly HeadlessDemoStageResult[];
  qualifications: readonly AutonomousRouteQualificationResult[];
  privatePublish?: HeadlessPrivatePublishResult;
  reportPath: string;
  success: boolean;
}

function businessDate(now: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(now));
  const get = (type: string) => parts.find((part) => part.type === type)?.value;
  const year = get("year"), month = get("month"), day = get("day");
  if (!year || !month || !day) throw new Error(`Could not derive business date in ${timeZone}`);
  return `${year}-${month}-${day}`;
}
function writeReport(path: string, report: Omit<HeadlessDemoReport, "reportPath">): HeadlessDemoReport {
  mkdirSync(resolve(path, ".."), { recursive: true, mode: 0o700 });
  const complete: HeadlessDemoReport = { ...report, reportPath: path };
  writeFileSync(path, `${JSON.stringify(complete, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return complete;
}
function boundedSeconds(raw: string | undefined, fallback: number, label: string, minimum: number, maximum: number): number {
  const parsed = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  return parsed;
}
async function verifyPrivatePublication(
  commands: WorkspacePrivateE2ECommands,
  runId: string,
  env: Record<string, string | undefined>,
  onProgress?: (message: string) => void
): Promise<string> {
  const timeoutSeconds = boundedSeconds(env.FLERDVISION_VERIFICATION_TIMEOUT_SECONDS, 180, "FLERDVISION_VERIFICATION_TIMEOUT_SECONDS", 30, 900);
  const intervalSeconds = boundedSeconds(env.FLERDVISION_VERIFICATION_POLL_SECONDS, 10, "FLERDVISION_VERIFICATION_POLL_SECONDS", 5, 60);
  const deadline = Date.now() + timeoutSeconds * 1000;
  let last = "verification not started";
  while (Date.now() <= deadline) {
    last = await commands.verify(runId, new Date().toISOString());
    if (last.includes("VERIFIED")) return last;
    onProgress?.(`PRIVATE_PUBLISH verification pending · ${last}`);
    await sleep(intervalSeconds * 1000);
  }
  throw new Error(`Private test publication was not verified within ${timeoutSeconds}s: ${last}`);
}

export async function runHeadlessDemo(input: {
  specPath: string;
  releaseSha: string;
  channelKeys?: readonly string[];
  privatePublish?: boolean;
  forceLogin?: boolean;
  headlessBrowser?: boolean;
  env?: Record<string, string | undefined>;
  onProgress?: (message: string) => void;
  /** Settle between the two source observations readiness requires. */
  stabilizeSettleMs?: number;
}): Promise<HeadlessDemoReport> {
  if (!input.releaseSha.trim()) throw new Error("Headless demo requires an exact release SHA");
  const env = input.env ?? process.env;
  const startedAt = new Date().toISOString();
  const runId = `headless-demo:${new Date(startedAt).getTime().toString(36)}`;
  const stages: HeadlessDemoStageResult[] = [];
  const qualifications: AutonomousRouteQualificationResult[] = [];
  const bootstrap = await bootstrapHeadlessWorkspace({ specPath: input.specPath, env, now: startedAt });
  stages.push({ stage: "BOOTSTRAP", status: "PASS", summary: `${bootstrap.compile.routes} route(s), ${bootstrap.compile.accounts} account(s), ${bootstrap.compile.lanes} source lane(s) compiled` });
  input.onProgress?.(`BOOTSTRAP PASS · ${bootstrap.compile.routes} routes from one canonical spec`);
  if (!bootstrap.topology.verified) {
    stages.push({ stage: "INGEST_PLAN", status: "FAIL", summary: bootstrap.topology.warnings.join(" · ") });
    throw new Error(`Source is not authenticated/verified. Run: npm run flerdvision -- drive-auth --spec ${input.specPath}`);
  }
  const selectedChannels = input.channelKeys?.length
    ? bootstrap.spec.channels.filter((channel) => input.channelKeys!.includes(channel.key))
    : [...bootstrap.spec.channels];
  if (selectedChannels.length === 0) throw new Error("No channel matched the requested channel keys");
  if (input.privatePublish && selectedChannels.length !== 1) throw new Error("Private publish demo must target exactly one channel");

  const layout = workspaceRuntimeLayout(bootstrap.runtimeRoot, bootstrap.spec.workspace.id);
  const probePath = resolve(layout.configDir, "session-probes.json");
  for (const channel of selectedChannels) {
    const calibrated = calibratedSessionProbeFor(loadSessionProbeConfigFile(probePath), accountIdForChannel(channel), channel.platform);
    if (!input.forceLogin && calibrated) {
      stages.push({ stage: "LOGIN", status: "SKIPPED", summary: `${channel.key} already has a calibrated persistent login profile` });
      input.onProgress?.(`LOGIN SKIPPED · ${channel.key} already calibrated`);
      continue;
    }
    // onProgress is optional on the callee, so under exactOptionalPropertyTypes the key must be
    // omitted rather than passed as undefined.
    const login = await ensureHeadlessLogin({ specPath: input.specPath, channelKey: channel.key, env, ...(input.onProgress ? { onProgress: input.onProgress } : {}) });
    stages.push({ stage: "LOGIN", status: "PASS", summary: `${channel.key} verified as @${login.observedHandle}` });
  }

  const date = businessDate(startedAt, bootstrap.spec.workspace.timezone);
  const runtime = new WorkspaceDistributionRuntime({ runtimeRoot: bootstrap.runtimeRoot, workspaceId: bootstrap.spec.workspace.id, env, timeZone: bootstrap.spec.workspace.timezone, releaseSha: input.releaseSha });
  try {
    // An operator-initiated acceptance run must actually observe the source. runCycle uses the
    // interval-gated poll, which silently returns zeros when it is not due yet and still reports
    // SOURCE_SCAN:PASS -- so a second demo within the polling interval looked like an empty
    // folder instead of a skipped scan.
    let scan = await runtime.source.forceScan(startedAt, "MANUAL");
    let scans = 1;
    // Readiness deliberately requires two observations of the same bytes, so first-touch media is
    // always STABILIZING after one scan. A second observation after a settle is the legitimate
    // way to satisfy that rule; the ffprobe readability check remains the substantive gate.
    if (scan.ready === 0 && scan.stabilizing > 0) {
      await sleep(input.stabilizeSettleMs ?? 5_000);
      scan = await runtime.source.forceScan(new Date().toISOString(), "MANUAL");
      scans = 2;
    }
    const first = await runtime.supervisor(`${runId}:bootstrap`).runCycle(new Date().toISOString(), date);
    const planPhase = first.phases.find((phase) => phase.phase === "PLAN");
    // A bare "did not pass" sends the operator digging through evidence; the phase already knows why.
    if (!planPhase || planPhase.status !== "PASS") throw new Error(`Planning did not pass: ${planPhase?.summary ?? "no PLAN phase ran"}`);
    const scanSummary = `${scans} forced scan(s) · observed=${scan.observed} ready=${scan.ready} stabilizing=${scan.stabilizing} blocked=${scan.blocked}`;
    stages.push({ stage: "INGEST_PLAN", status: "PASS", summary: `${scanSummary} · ${first.phases.map((phase) => `${phase.phase}:${phase.status}`).join(" · ")}` });
    input.onProgress?.(`INGEST_PLAN PASS · ${scanSummary}`);
    if (scan.ready === 0) {
      throw new Error(
        `No source asset reached READY after ${scans} scan(s): observed=${scan.observed} stabilizing=${scan.stabilizing} blocked=${scan.blocked}. ` +
        `Readiness needs two observations of identical bytes plus a readable media probe; a still-uploading or unreadable file stays out of the publish path on purpose.`
      );
    }
  } finally { runtime.close(); }

  const selectedAccountIds = new Set(selectedChannels.map(accountIdForChannel));
  const qualifier = new AutonomousRouteQualifier({ runtimeRoot: bootstrap.runtimeRoot, workspaceId: bootstrap.spec.workspace.id, releaseSha: input.releaseSha, env, headless: input.headlessBrowser ?? false });
  try {
    const routeIds = qualifier.routes();
    const config = new JsonDistributionConfigurationStore(resolve(layout.configDir, "distribution.json"));
    const routes = config.load().config.routes.filter((route) => routeIds.includes(route.routeId) && selectedAccountIds.has(route.accountId));
    // One route must not take the channel's other routes down with it: a Trial-Reel route whose
    // switch Instagram has not enabled yet fails closed on its own, while the Reel route beside
    // it still qualifies and posts. The failure is recorded and reported, never hidden.
    const failures: string[] = [];
    for (const route of routes) {
      input.onProgress?.(`QUALIFY · ${route.displayName}`);
      try {
        qualifications.push(await qualifier.qualify(route.routeId));
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        failures.push(`${route.displayName}: ${reason}`);
        stages.push({ stage: "QUALIFY", status: "FAIL", summary: `${route.displayName} — ${reason}` });
        input.onProgress?.(`QUALIFY FAIL · ${route.displayName} · ${reason}`);
      }
    }
    if (qualifications.length === 0) throw new Error(failures[0] ? `No selected route was qualified: ${failures[0]}` : "No selected route was qualified");
    stages.push({ stage: "QUALIFY", status: "PASS", summary: `${qualifications.length} route(s) calibrated with three real prepare-only replays each` });
    input.onProgress?.(`QUALIFY PASS · ${qualifications.length} route(s)`);
  } finally { qualifier.close(); }

  const scheduledRuntime = new WorkspaceDistributionRuntime({ runtimeRoot: bootstrap.runtimeRoot, workspaceId: bootstrap.spec.workspace.id, env, timeZone: bootstrap.spec.workspace.timezone, releaseSha: input.releaseSha });
  try {
    const second = await scheduledRuntime.supervisor(`${runId}:schedule`).runCycle(new Date().toISOString(), date);
    const intents = second.phases.find((phase) => phase.phase === "INTENTS");
    if (!intents || intents.status !== "PASS") throw new Error(`Intent materialization did not pass: ${intents?.summary ?? "missing"}`);
    stages.push({ stage: "SCHEDULE", status: "PASS", summary: intents.summary });
    input.onProgress?.(`SCHEDULE PASS · ${intents.summary}`);
  } finally { scheduledRuntime.close(); }

  let privatePublish: HeadlessPrivatePublishResult | undefined;
  if (input.privatePublish) {
    const test = bootstrap.spec.privateTest;
    if (!test.enabled || !test.accountPrivate || test.approvedFollowers !== 0 || !test.contactsSyncOff || !test.crossPostingOff) {
      throw new Error("Private publish requires privateTest.enabled, private account, zero followers, contacts sync off and cross-posting off in the canonical spec");
    }
    // Account privacy protects an Instagram test, but on platforms with per-post visibility the
    // post's own audience decides who sees it: a tiktok/youtube channel left on its default
    // (everyone/public) would pass every attestation above and still publish publicly. The
    // private test therefore demands the platform's zero-viewer visibility on every format of
    // the selected channel before anything irreversible is reachable.
    const ZERO_VIEWER_VISIBILITY: Readonly<Record<string, string>> = { tiktok: "only_you", youtube: "private" };
    for (const channel of selectedChannels) {
      const required = ZERO_VIEWER_VISIBILITY[channel.platform];
      if (!required) continue;
      for (const format of channel.formats) {
        const visibility = format.settings.visibility;
        if (visibility !== required) {
          throw new Error(
            `Private publish on ${channel.platform} requires settings.visibility "${required}" on every format of ${channel.key}; ` +
            `found "${visibility ?? "unset (platform default)"}" for format ${format.type}. A default visibility would publish publicly.`
          );
        }
      }
    }
    const allowedAccountId = accountIdForChannel(selectedChannels[0]!);
    const commands = new WorkspacePrivateE2ECommands({ runtimeRoot: bootstrap.runtimeRoot, workspaceId: bootstrap.spec.workspace.id, releaseSha: input.releaseSha, allowedAccountIds: new Set([allowedAccountId]), operatorId: "headless-demo", env });
    try {
      const candidate = commands.candidates().find((item) => item.intent.accountId === allowedAccountId);
      if (!candidate) throw new Error(`No SCHEDULED private-test intent exists for ${allowedAccountId}`);
      const run = commands.start(candidate.intent.intentId, `Headless demo ${runId}`, new Date().toISOString());
      await commands.syncEvidence(run.runId, new Date().toISOString());
      commands.attestPrivacy(run.runId, {
        accountPrivate: test.accountPrivate,
        approvedFollowers: test.approvedFollowers,
        contactsSyncOff: test.contactsSyncOff,
        crossPostingOff: test.crossPostingOff,
        testMediaOnly: true
      }, new Date().toISOString());
      await commands.prepare(run.runId, new Date().toISOString());
      const finalAction = await commands.invokeFinal(run.runId, "PRIVATE_E2E_FINAL_ACTION", new Date().toISOString());
      const verification = await verifyPrivatePublication(commands, run.runId, env, input.onProgress);
      privatePublish = { runId: run.runId, intentId: candidate.intent.intentId, accountId: allowedAccountId, finalAction, verification, cleanupRequired: true };
      stages.push({ stage: "PRIVATE_PUBLISH", status: "PASS", summary: `${finalAction}; ${verification}; manual deletion confirmation remains required` });
      input.onProgress?.("PRIVATE_PUBLISH PASS · exactly one private test post invoked and verified");
    } finally { await commands.close(); }
  } else stages.push({ stage: "PRIVATE_PUBLISH", status: "SKIPPED", summary: "Prepare-only qualification completed; irreversible final action was not requested" });

  const finishedAt = new Date().toISOString();
  const reportDirectory = resolve(layout.evidenceDir, "headless", "reports");
  const reportPath = join(reportDirectory, `${runId.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`);
  stages.push({ stage: "REPORT", status: "PASS", summary: reportPath });
  return writeReport(reportPath, {
    schemaVersion: 1,
    runId,
    startedAt,
    finishedAt,
    releaseSha: input.releaseSha,
    workspaceId: bootstrap.spec.workspace.id,
    ownerEmail: bootstrap.spec.workspace.ownerEmail,
    businessDate: date,
    stages,
    qualifications,
    ...(privatePublish ? { privatePublish } : {}),
    success: stages.every((stage) => stage.status !== "FAIL")
  });
}
