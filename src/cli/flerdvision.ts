import { spawnSync } from "node:child_process";
import { authorizeWorkspaceDrive } from "../application/headless-drive-auth.js";
import { bootstrapHeadlessWorkspace, loadWorkspaceSpecFile } from "../application/headless-bootstrap.js";
import { runHeadlessDemo } from "../application/headless-demo.js";
import { ensureHeadlessLogin } from "../application/headless-login.js";

function value(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}
function values(argv: readonly string[], name: string): readonly string[] {
  const out: string[] = [];
  for (let index = 0; index < argv.length; index += 1) if (argv[index] === name && argv[index + 1]) out.push(argv[index + 1]!);
  return out;
}
function flag(argv: readonly string[], name: string): boolean { return argv.includes(name); }
function required(argv: readonly string[], name: string): string {
  const found = value(argv, name)?.trim();
  if (!found) throw new Error(`${name} is required`);
  return found;
}
function releaseSha(argv: readonly string[]): string {
  const explicit = value(argv, "--release-sha") ?? process.env.FLERDVISION_RELEASE_SHA;
  if (explicit?.trim()) return explicit.trim();
  const run = spawnSync("git", ["rev-parse", "HEAD"], { cwd: process.cwd(), encoding: "utf8", timeout: 5000 });
  if (run.status !== 0 || !run.stdout.trim()) throw new Error("Could not determine exact release SHA; use --release-sha or FLERDVISION_RELEASE_SHA");
  return run.stdout.trim();
}
function usage(): never {
  console.error(`Flerdvision headless commands:\n\n  npm run flerdvision -- bootstrap --spec <flerdvision.json>\n  npm run flerdvision -- drive-auth --spec <flerdvision.json>\n  npm run flerdvision -- login --spec <flerdvision.json> --channel <channel-key>\n  npm run flerdvision -- demo --spec <flerdvision.json> [--channel <key>] [--private-publish] [--force-login] [--headless]\n\nThe default product path has no setup/calibration UI. A social login browser opens only when human login or 2FA is needed.`);
  process.exitCode = 2;
  throw new Error("invalid arguments");
}

async function main(): Promise<void> {
  const [command, ...argv] = process.argv.slice(2);
  if (!command || command === "help" || flag(argv, "--help")) return usage();
  const specPath = required(argv, "--spec");
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
    const result = await authorizeWorkspaceDrive({ specPath, port: Number(value(argv, "--port") ?? process.env.FLERDVISION_DRIVE_OAUTH_PORT ?? "8765"), openBrowser: !flag(argv, "--no-open") });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "login") {
    const result = await ensureHeadlessLogin({ specPath, channelKey: required(argv, "--channel"), onProgress: (message) => console.error(message) });
    console.log(JSON.stringify(result, null, 2));
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
  return usage();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
