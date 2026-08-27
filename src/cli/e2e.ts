import { SqliteControlPlaneStore } from "../adapters/storage/sqlite.js";
import { NodeHostPreflightAdapter } from "../adapters/e2e/host-preflight.js";
import { E2EPublishPermitService, PrivateE2ERunService } from "../application/private-e2e.js";
import { resolveChromiumExecutablePath } from "../adapters/browser/resolve-chromium.js";
import { resolveFfprobeExecutablePath } from "../adapters/media/resolve-ffprobe.js";

function arg(name: string): string | undefined { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; }
function required(name: string): string { const value = arg(name); if (!value) throw new Error(`Missing ${name}`); return value; }
function bool(name: string): boolean { return required(name).toLocaleLowerCase("en-US") === "true"; }

const command = process.argv[2] ?? "help";
const dbPath = arg("--db") ?? process.env.DATABASE_URL?.replace(/^file:/, "") ?? "runtime/flerdvision.sqlite";
const operatorId = arg("--operator") ?? "operator";
const actor = { type: "operator" as const, id: operatorId };

async function main(): Promise<void> {
  if (command === "preflight") {
    const result = await new NodeHostPreflightAdapter({
      chromiumExecutablePath: resolveChromiumExecutablePath(),
      ffprobeExecutablePath: resolveFfprobeExecutablePath(),
      runtimeDir: process.env.RUNTIME_DIR ?? "runtime",
      profilesDir: process.env.BROWSER_PROFILE_DIR ?? "profiles",
      evidenceDir: process.env.EVIDENCE_DIR ?? "artifacts/evidence"
    }).check(new Date().toISOString());
    console.log(JSON.stringify(result, null, 2));
    if (!result.ready) process.exitCode = 2;
    return;
  }

  const store = new SqliteControlPlaneStore(dbPath);
  try {
    const service = new PrivateE2ERunService(store);
    if (command === "start") {
      const note = arg("--note");
      const run = service.start({
        runId: required("--run-id"), accountId: required("--account-id"), platform: required("--platform") as "instagram" | "tiktok" | "youtube",
        releaseSha: required("--release-sha"), now: new Date().toISOString(), operatorId,
        zeroViewerRequired: arg("--zero-viewer-required") === undefined ? true : bool("--zero-viewer-required"),
        ...(note ? { note } : {})
      }, actor);
      console.log(JSON.stringify(run, null, 2)); return;
    }
    if (command === "status") {
      const runId = required("--run-id");
      console.log(JSON.stringify({ run: store.getE2ERun(runId), gates: store.listE2EGateResults(runId) }, null, 2)); return;
    }
    if (command === "attest-privacy") {
      const result = service.attestPrivacy(required("--run-id"), {
        accountPrivate: bool("--account-private"), approvedFollowers: Number(required("--approved-followers")),
        contactsSyncOff: bool("--contacts-sync-off"), crossPostingOff: bool("--cross-posting-off"), testMediaOnly: bool("--test-media-only")
      }, new Date().toISOString(), operatorId, actor);
      console.log(JSON.stringify(result, null, 2)); return;
    }
    if (command === "permit") {
      if (required("--confirm") !== "PRIVATE_E2E_FINAL_ACTION") throw new Error("Permit issuance requires --confirm PRIVATE_E2E_FINAL_ACTION");
      const runId = required("--run-id"); const intentId = required("--intent-id"); const intent = store.getIntent(intentId)?.intent;
      if (!intent) throw new Error(`Unknown publication intent: ${intentId}`);
      const releaseSha = required("--release-sha");
      const issued = new E2EPublishPermitService(store).issue({
        runId, intent, context: { mode: "test_account", allowFinalPublish: true, allowedAccountIds: new Set([intent.accountId]), releaseSha },
        now: new Date().toISOString(), operatorId, ttlSeconds: Number(arg("--ttl-seconds") ?? "300")
      }, actor);
      console.log(JSON.stringify({ permit: issued.permit, token: issued.token, warning: "Token is shown once. Keep it only in the private operator session and never store it in Git/logs." }, null, 2)); return;
    }
    throw new Error("Usage: e2e preflight | start | status | attest-privacy | permit");
  } finally { store.close(); }
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
