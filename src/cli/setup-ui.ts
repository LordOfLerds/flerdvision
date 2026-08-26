import { resolve } from "node:path";
import { JsonWorkspaceRegistry } from "../adapters/workspace/json-registry.js";
import { FixedCommandTestRunner } from "../adapters/test-lab/fixed-command-runner.js";
import { SelfServiceHttpServer, type DriveOAuthPort } from "../adapters/setup/self-service-http.js";
import { resolveChromiumExecutablePath } from "../adapters/browser/resolve-chromium.js";
import { GoogleDriveFolderBrowser } from "../adapters/ingress/google-drive/google-drive-browser.js";
import { LocalFolderBrowser } from "../adapters/ingress/local/local-folder-browser.js";
import { FetchHttpJson, FileDriveCredentialStore, driveOAuthClientFromEnv } from "../adapters/ingress/google-drive/drive-credentials.js";
import { RefreshingAccessToken, beginAuthorization, exchangeAuthorizationCode } from "../adapters/ingress/google-drive/google-oauth.js";
import { workspaceRuntimeLayout } from "../application/workspaces.js";

function arg(name: string): string | undefined { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; }

const runtimeRoot = resolve(arg("--runtime-root") ?? process.env.FLERDVISION_RUNTIME_ROOT ?? "runtime");
const repoRoot = resolve(arg("--repo-root") ?? process.env.FLERDVISION_REPO_ROOT ?? process.cwd());
const password = arg("--password") ?? process.env.FLERDVISION_SETUP_PASSWORD;
if (!password) throw new Error("Set --password or FLERDVISION_SETUP_PASSWORD");

const host = arg("--host") ?? "127.0.0.1";
const port = Number(arg("--port") ?? "8788");
const http = new FetchHttpJson();

/**
 * Drive is optional at startup. Without an OAuth client the wizard still runs and explains what is
 * missing, which is better than a UI that looks configurable and fails at the first click.
 */
function driveWiring(): { oauth?: DriveOAuthPort; browser?: GoogleDriveFolderBrowser } {
  const anyWorkspace = new JsonWorkspaceRegistry(resolve(runtimeRoot, "registry", "workspaces.json")).list()[0];
  const client = driveOAuthClientFromEnv(process.env, `http://${host}:${port}/workspaces/${anyWorkspace?.workspaceId ?? "WORKSPACE"}/drive/callback`);
  if (!client) return {};

  const oauth: DriveOAuthPort = {
    begin(workspaceId) {
      return beginAuthorization({ ...client, redirectUri: `http://${host}:${port}/workspaces/${workspaceId}/drive/callback` });
    },
    async complete(workspaceId, code, codeVerifier) {
      const tokens = await exchangeAuthorizationCode({
        http,
        client: { ...client, redirectUri: `http://${host}:${port}/workspaces/${workspaceId}/drive/callback` },
        code, codeVerifier, now: Date.now()
      });
      return { clientId: client.clientId, refreshToken: tokens.refreshToken!, connectedAt: new Date().toISOString() };
    }
  };

  // The browser resolves its credential per request, so connecting a workspace takes effect
  // without restarting the UI.
  const browser = new GoogleDriveFolderBrowser({
    http,
    token: {
      async accessToken() {
        const first = new JsonWorkspaceRegistry(resolve(runtimeRoot, "registry", "workspaces.json")).list()[0];
        if (!first) throw new Error("No workspace to read Drive credentials from");
        const stored = new FileDriveCredentialStore(workspaceRuntimeLayout(runtimeRoot, first.workspaceId).configDir).read();
        if (!stored) throw new Error("This workspace is not connected to Drive");
        return await new RefreshingAccessToken({
          http, client: { ...client, redirectUri: "" }, refreshToken: stored.refreshToken
        }).accessToken();
      }
    }
  });
  return { oauth, browser };
}

// A mounted cloud folder needs no credential, so it wins when configured: the simpler path
// should be the one that just works.
const sourceRoot = arg("--source-root") ?? process.env.FLERDVISION_SOURCE_ROOT;
const { oauth, browser } = sourceRoot ? { oauth: undefined, browser: undefined } : driveWiring();
const localBrowser = sourceRoot ? new LocalFolderBrowser({ root: resolve(sourceRoot) }) : undefined;
const registry = new JsonWorkspaceRegistry(resolve(runtimeRoot, "registry", "workspaces.json"));
const server = new SelfServiceHttpServer(registry, {
  runtimeRoot, repoRoot, password,
  username: arg("--username") ?? "flerdvision",
  host, port,
  chromiumExecutablePath: arg("--chromium") ?? resolveChromiumExecutablePath(),
  testRunner: new FixedCommandTestRunner(),
  ...(localBrowser ? { folderBrowser: localBrowser, localSourceRoot: resolve(sourceRoot!) } : {}),
  ...(browser ? { folderBrowser: browser } : {}),
  ...(oauth ? { driveOAuth: oauth } : {})
  // channelDiscovery stays unset until config/channel-discovery.json is calibrated: an
  // uncalibrated spec must refuse, and the wizard says so rather than offering a text field.
});

const listening = await server.start();
console.log(`Flerdvision self-service UI listening on http://${listening.host}:${listening.port}`);
if (localBrowser) console.log(`Source: local folder ${resolve(sourceRoot!)} (no credential needed).`);
else if (!oauth) console.log("No source configured. Either pass --source-root <path> to a mounted folder, or set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET for the Drive API.");
console.log("Channel discovery is not wired: calibrate config/channel-discovery.json before step 4.");
await new Promise<void>((resolvePromise) => { process.on("SIGINT", resolvePromise); process.on("SIGTERM", resolvePromise); });
await server.stop();
