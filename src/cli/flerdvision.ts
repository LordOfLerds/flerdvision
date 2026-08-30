import { spawnSync } from "node:child_process";
import { HeadlessAutonomousRuntime } from "../application/headless-autonomous-runtime.js";
import { authorizeWorkspaceDrive } from "../application/headless-drive-auth.js";
import { bootstrapHeadlessWorkspace, loadWorkspaceSpecFile } from "../application/headless-bootstrap.js";
import { runHeadlessDemo } from "../application/headless-demo.js";
import { ensureHeadlessLogin } from "../application/headless-login.js";
import { inspectHeadlessWorkspace } from "../application/headless-status.js";
import { accountIdForChannel } from "../application/workspace-spec-compiler.js";
import { WorkspacePrivateE2ECommands } from "../adapters/runtime/workspace-private-e2e.js";

function value(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}
function values(argv: readonly string[], name: string): readonly string[] {
  const out: string[] = [];
  for (let index = 0; index < argv.length; index += 1) if (argv[index] === name && argv[index + 1]) out.push(argv[index + 1]!);
  return [...new Set(out)];
}
function flag(argv: readonly string[], name: string): boolean { return argv.includes(name); }
function required(argv: readonly string[], name: string): string {
  const found = value(argv, name)?.trim();
  if (!found) throw new Error(`${name} is required`);
  return found;
}
function positiveInteger(raw: string | undefined, fallback: number, label: string, minimum: number, maximum: number): number {
  const parsed = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  return parsed;
}
function canonicalSpecPath(argv: readonly string[]): string {
  const found = value(argv, "--spec") ?? process.env.FLERDVISION_SPEC;
  if (!found?.trim()) throw new Error("Set --spec or FLERDVISION_SPEC to the canonical flerdvision.json file");
  return found.trim();
}
function releaseSha(argv: readonly string[]): string {
  const explicit = value(argv, "--release-sha") ?? process.env.FLERDVISION_RELEASE_SHA;
  if (explicit?.trim()) return explicit.trim();
  const run = spawnSync("git", ["rev-parse", "HEAD"], { cwd: process.cwd(), encoding: "utf8", timeout: 5000 });
  if (run.status !== 0 || !run.stdout.trim()) throw new Error("Could not determine exact release SHA; use --release-sha or FLERDVISION_RELEASE_SHA");
  return run.stdout.trim();
}
function authorizedMode(argv: readonly string[]): "canary" | "production" {
  const mode = value(argv, "--mode") ?? "canary";
  if (mode !== "canary" && mode !== "production") throw new Error("--mode must be canary or production");
  if (process.env.ALLOW_FINAL_PUBLISH !== "true") throw new Error("Autonomous final publishing requires independent environment gate ALLOW_FINAL_PUBLISH=true");
  if (value(argv, "--confirm") !== "AUTONOMOUS_FINAL_PUBLISH") throw new Error("Autonomous final publishing requires --confirm AUTONOMOUS_FINAL_PUBLISH");
  return mode;
}
function usage(): never {
  console.error(`Flerdvision headless commands:\n\n  npm run flerdvision -- bootstrap [--spec <flerdvision.json>]\n  npm run flerdvision -- drive-auth [--spec <flerdvision.json>]\n  npm run flerdvision -- login --channel <channel-key>\n  npm run flerdvision -- doctor [--release-sha <sha>]\n  npm run flerdvision -- demo [--channel <key>] [--private-publish] [--force-login] [--headless]\n  npm run flerdvision -- cleanup --run-id <id> --confirm PRIVATE_E2E_TEST_POST_DELETED --note <evidence>\n  npm run flerdvision -- run-once --channel <key> --mode canary --confirm AUTONOMOUS_FINAL_PUBLISH\n  npm run flerdvision -- daemon --channel <key> --mode canary --confirm AUTONOMOUS_FINAL_PUBLISH [--interval 60]\n\nSet FLERDVISION_SPEC once to avoid repeating --spec. The default product path has no setup/calibration UI. A social login browser opens only when human login or 2FA is needed. Final publishing additionally requires ALLOW_FINAL_PUBLISH=true.`);
  process.exitCode = 2;
  throw new Error("invalid arguments");
}

async function main(): Promise<void> {
  const [command, ...argv] = process.argv.slice(2);
  if (!command || command === "help" || flag(argv, "--help")) return usage();
  const specPath = canonicalSpecPath(argv);
  if (command === "bootstrap") {
    const result = await bootstrapHeadlessWorkspace({ specPath });
    console.log(JSON.stringify({
      workspaceId: result.spec.workspace.id,
      ownerEmail: result.spec.workspace.ownerEmail,
      topologyVerified: result.topology.verified,
      sourceWarnings: result.topology.warnings,
      compile: result.compile,
      next: result.topology.verified ? "login_or_demo" : "drive-auth"
    }, null, 2));
    return;
  }
  if (command === "drive-auth") {
    const result = await authorizeWorkspaceDrive({
      specPath,
      port: positiveInteger(value(argv, "--port") ?? process.env.FLERDVISION_DRIVE_OAUTH_PORT, 8765, "--port", 1024, 65535),
      openBrowser: !flag(argv, "--no-open"),
      onAuthorizationUrl: (url) => console.error(`Open this URL to authorize Google Drive:\n${url}`)
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "login") {
    const loginTimeoutMinutes = positiveInteger(value(argv, "--login-timeout") ?? process.env.FLERDVISION_LOGIN_TIMEOUT_MINUTES, 15, "--login-timeout", 1, 120);
    const result = await ensureHeadlessLogin({
      specPath,
      channelKey: required(argv, "--channel"),
      timeoutMs: loginTimeoutMinutes * 60_000,
      onProgress: (message) => console.error(message)
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "doctor") {
    console.log(JSON.stringify(inspectHeadlessWorkspace({ specPath, releaseSha: releaseSha(argv) }), null, 2));
    return;
  }
  if (command === "demo" || command === "auto") {
    const spec = loadWorkspaceSpecFile(specPath);
    const selected = values(argv, "--channel");
    for (const key of selected) if (!spec.channels.some((channel) => channel.key === key)) throw new Error(`Unknown --channel ${key}`);
    const report = await runHeadlessDemo({
      specPath,
      releaseSha: releaseSha(argv),
      ...(selected.length > 0 ? { channelKeys: selected } : {}),
      privatePublish: flag(argv, "--private-publish"),
      forceLogin: flag(argv, "--force-login"),
      headlessBrowser: flag(argv, "--headless"),
      onProgress: (message) => console.error(message)
    });
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (command === "cleanup") {
    const spec = loadWorkspaceSpecFile(specPath);
    const sha = releaseSha(argv);
    const commands = new WorkspacePrivateE2ECommands({
      runtimeRoot: spec.workspace.runtimeRoot,
      workspaceId: spec.workspace.id,
      releaseSha: sha,
      allowedAccountIds: new Set(spec.channels.map(accountIdForChannel)),
      operatorId: "headless-cleanup"
    });
    try {
      commands.confirmCleanup(
        required(argv, "--run-id"),
        required(argv, "--confirm"),
        required(argv, "--note"),
        new Date().toISOString()
      );
    } finally { await commands.close(); }
    console.log(JSON.stringify({ cleanup: "PASS", doctor: inspectHeadlessWorkspace({ specPath, releaseSha: sha }) }, null, 2));
    return;
  }
  if (command === "run-once" || command === "daemon") {
    const channels = values(argv, "--channel");
    if (channels.length === 0) throw new Error("Autonomous runtime requires at least one explicit --channel allowlist entry");
    const mode = authorizedMode(argv);
    await bootstrapHeadlessWorkspace({ specPath });
    const runtime = new HeadlessAutonomousRuntime({
      specPath,
      releaseSha: releaseSha(argv),
      mode,
      channelKeys: channels,
      allowFinalPublish: true,
      headless: !flag(argv, "--show-browser"),
      maxPerCycle: positiveInteger(value(argv, "--max-per-cycle"), 4, "--max-per-cycle", 1, 100)
    });
    try {
      if (command === "run-once") {
        console.log(JSON.stringify(await runtime.runOnce(), null, 2));
        return;
      }
      const signal = { aborted: false };
      const abort = () => { signal.aborted = true; };
      process.on("SIGINT", abort);
      process.on("SIGTERM", abort);
      await runtime.runDaemon({
        intervalSeconds: positiveInteger(value(argv, "--interval"), 60, "--interval", 15, 3600),
        signal,
        onCycle: (report) => console.log(JSON.stringify(report))
      });
      return;
    } finally { await runtime.close(); }
  }
  return usage();
}

main().catch((error) => {
  // A bare "fetch failed" cost a live acceptance window twice: undici hides the socket-level
  // cause (ENOTFOUND, ECONNRESET, proxy, TLS) one level down. Print the whole cause chain.
  let current: unknown = error;
  const lines: string[] = [];
  while (current) {
    const err = current instanceof Error ? current : new Error(String(current));
    const code = (current as { code?: string }).code;
    lines.push(`${lines.length === 0 ? "" : "  caused by: "}${code ? `[${code}] ` : ""}${err.message}`);
    current = (current as { cause?: unknown }).cause;
  }
  console.error(lines.join("\n"));
  process.exitCode = 1;
});
