import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { bootstrapHeadlessWorkspace } from "./headless-bootstrap.js";
import { ensureHeadlessLogin } from "./headless-login.js";
import { AutonomousRouteQualifier, type AutonomousRouteQualificationResult } from "./autonomous-surface-qualification.js";
import { accountIdForChannel } from "./workspace-spec-compiler.js";
import { workspaceRuntimeLayout } from "./workspaces.js";
import { calibratedSessionProbeFor, loadSessionProbeConfigFile } from "../adapters/browser/session-probe-config.js";
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

export async function runHeadlessDemo(input: {
  specPath: string;
  releaseSha: string;
  channelKeys?: readonly string[];
  privatePublish?: boolean;
  forceLogin?: boolean;
  headlessBrowser?: boolean;
  env?: Record<string, string | undefined>;
  onProgress?: (message: string) => void;
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
    const login = await ensureHeadlessLogin({ specPath: input.specPath, channelKey: channel.key, env, onProgress: input.onProgress });
    stages.push({ stage: "LOGIN", status: "PASS", summary: `${channel.key} verified as @${login.observedHandle}` });
  }

  const date = businessDate(startedAt, bootstrap.spec.workspace.timezone);
  const runtime = new WorkspaceDistributionRuntime({ runtimeRoot: bootstrap.runtimeRoot, workspaceId: bootstrap.spec.workspace.id, env, timeZone: bootstrap.spec.workspace.timezone, releaseSha: input.releaseSha });
  try {
    const first = await runtime.supervisor(`${runId}:bootstrap`).runCycle(startedAt, date);
    if (!first.phases.find((phase) => phase.phase === "SOURCE_SCAN" && phase.status === "PASS")) throw new Error("Source scan did not pass");
    if (!first.phases.find((phase) => phase.phase === "PLAN" && phase.status === "PASS")) throw new Error("Planning did not pass");
    stages.push({ stage: "INGEST_PLAN", status: "PASS", summary: first.phases.map((phase) => `${phase.phase}:${phase.status}`).join(" · ") });
    input.onProgress?.("INGEST_PLAN PASS · source scanned and deterministic plan persisted");
  } finally { runtime.close(); }

  const selectedAccountIds = new Set(selectedChannels.map(accountIdForChannel));
  const qualifier = new AutonomousRouteQualifier({ runtimeRoot: bootstrap.runtimeRoot, workspaceId: bootstrap.spec.workspace.id, releaseSha: input.releaseSha, env, headless: input.headlessBrowser ?? false });
  try {
    const routeIds = qualifier.routes();
    const config = new (await import("../adapters/distribution/json-config-store.js")).JsonDistributionConfigurationStore(resolve(layout.configDir, "distribution.json"));
    const routes = config.load().config.routes.filter((route) => routeIds.includes(route.routeId) && selectedAccountIds.has(route.accountId));
    for (const route of routes) {
      input.onProgress?.(`QUALIFY · ${route.displayName}`);
      qualifications.push(await qualifier.qualify(route.routeId));
    }
    if (qualifications.length === 0) throw new Error("No selected route was qualified");
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
      const verification = await commands.verify(run.runId, new Date().toISOString());
      if (!verification.includes("VERIFIED")) throw new Error(`Private test publication was not verified: ${verification}`);
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
