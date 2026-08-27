import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { FileDriveCredentialStore, FetchHttpJson, driveOAuthClientFromEnv } from "../adapters/ingress/google-drive/drive-credentials.js";
import { beginAuthorization, exchangeAuthorizationCode } from "../adapters/ingress/google-drive/google-oauth.js";
import { JsonWorkspaceRegistry } from "../adapters/workspace/json-registry.js";
import { loadWorkspaceSpecFile } from "./headless-bootstrap.js";
import { WorkspaceService, workspaceRuntimeLayout } from "./workspaces.js";

export interface HeadlessDriveAuthResult {
  workspaceId: string;
  connectedAt: string;
  authorizationUrl: string;
  callbackUrl: string;
}

function openUrl(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try { spawn(command, args, { stdio: "ignore" }); } catch { /* URL is still printed by the CLI. */ }
}

export async function authorizeWorkspaceDrive(input: {
  specPath: string;
  env?: Record<string, string | undefined>;
  port?: number;
  timeoutMs?: number;
  openBrowser?: boolean;
}): Promise<HeadlessDriveAuthResult> {
  const spec = loadWorkspaceSpecFile(input.specPath);
  if (spec.source.kind !== "google_drive") throw new Error("drive-auth is only valid for a google_drive source");
  const env = input.env ?? process.env;
  const port = input.port ?? Number(env.FLERDVISION_DRIVE_OAUTH_PORT ?? "8765");
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Drive OAuth port must be an integer from 1024 to 65535");
  const callbackUrl = `http://127.0.0.1:${port}/callback`;
  const client = driveOAuthClientFromEnv(env, callbackUrl);
  if (!client) throw new Error("GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET are required for Drive authorization");
  const runtimeRoot = resolve(spec.workspace.runtimeRoot);
  const registry = new JsonWorkspaceRegistry(resolve(runtimeRoot, "registry", "workspaces.json"));
  new WorkspaceService(registry, runtimeRoot).create({ workspaceId: spec.workspace.id, displayName: spec.workspace.name, timezone: spec.workspace.timezone, now: new Date().toISOString() });
  const layout = workspaceRuntimeLayout(runtimeRoot, spec.workspace.id);
  const pending = beginAuthorization(client);
  const http = new FetchHttpJson();
  let settled = false;

  return await new Promise<HeadlessDriveAuthResult>((resolvePromise, rejectPromise) => {
    let timer: number | undefined;
    const clearDeadline = () => { if (timer !== undefined) { clearTimeout(timer); timer = undefined; } };
    const server = createServer(async (req, res) => {
      if (settled) { res.statusCode = 409; res.end("Authorization already completed"); return; }
      try {
        const url = new URL(req.url ?? "/", callbackUrl);
        if (url.pathname !== "/callback") { res.statusCode = 404; res.end("Not found"); return; }
        const error = url.searchParams.get("error");
        if (error) throw new Error(`Google authorization failed: ${error}`);
        const state = url.searchParams.get("state") ?? "";
        const code = url.searchParams.get("code") ?? "";
        if (state !== pending.state) throw new Error("Google OAuth state mismatch");
        if (!code) throw new Error("Google callback did not contain an authorization code");
        const tokens = await exchangeAuthorizationCode({ http, client, code, codeVerifier: pending.codeVerifier, now: Date.now() });
        const connectedAt = new Date().toISOString();
        new FileDriveCredentialStore(layout.configDir).write({ clientId: client.clientId, refreshToken: tokens.refreshToken!, connectedAt });
        settled = true;
        clearDeadline();
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end("<!doctype html><meta charset=utf-8><title>Flerdvision Drive connected</title><h1>Google Drive verbunden</h1><p>Dieses Fenster kann geschlossen werden.</p>");
        server.close(() => resolvePromise({ workspaceId: spec.workspace.id, connectedAt, authorizationUrl: pending.authorizationUrl, callbackUrl }));
      } catch (error) {
        settled = true;
        clearDeadline();
        const message = error instanceof Error ? error.message : String(error);
        res.statusCode = 409;
        res.end(message);
        server.close(() => rejectPromise(new Error(message)));
      }
    });
    server.listen(port, "127.0.0.1", () => {
      if (input.openBrowser ?? true) openUrl(pending.authorizationUrl);
    });
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      clearDeadline();
      server.close(() => rejectPromise(new Error("Google Drive authorization timed out")));
    }, input.timeoutMs ?? 10 * 60_000);
  });
}
