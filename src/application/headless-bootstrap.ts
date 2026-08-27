import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JsonWorkspaceRegistry } from "../adapters/workspace/json-registry.js";
import { JsonDistributionConfigurationStore } from "../adapters/distribution/json-config-store.js";
import { SqliteControlPlaneStore } from "../adapters/storage/sqlite.js";
import { LocalFolderBrowser, LOCAL_ROOT } from "../adapters/ingress/local/local-folder-browser.js";
import { GoogleDriveFolderBrowser } from "../adapters/ingress/google-drive/google-drive-browser.js";
import { FileDriveCredentialStore, FetchHttpJson } from "../adapters/ingress/google-drive/drive-credentials.js";
import { RefreshingAccessToken } from "../adapters/ingress/google-drive/google-oauth.js";
import { WorkspaceService, workspaceRuntimeLayout } from "./workspaces.js";
import { parseWorkspaceSpec, type WorkspaceSpecV1 } from "../domain/workspace-spec.js";
import { WorkspaceSpecCompiler, type WorkspaceCompileReport } from "./workspace-spec-compiler.js";
import {
  discoverSourceTopology,
  extractGoogleDriveFolderId,
  unverifiedRootTopology,
  type SourceTopology
} from "./source-structure-discovery.js";

export interface HeadlessBootstrapResult {
  spec: WorkspaceSpecV1;
  topology: SourceTopology;
  compile: WorkspaceCompileReport;
  runtimeRoot: string;
  databasePath: string;
  configDir: string;
}

export function loadWorkspaceSpecFile(path: string): WorkspaceSpecV1 {
  return parseWorkspaceSpec(JSON.parse(readFileSync(resolve(path), "utf8")) as unknown);
}

function googleTopology(spec: WorkspaceSpecV1, configDir: string, env: Record<string, string | undefined>): Promise<SourceTopology> | SourceTopology {
  const rootId = extractGoogleDriveFolderId(spec.source.root);
  const credential = new FileDriveCredentialStore(configDir).read();
  if (!credential) {
    return unverifiedRootTopology({
      rootId,
      rootPath: `Google Drive / ${rootId}`,
      folderRef: rootId,
      channels: spec.channels,
      reason: "Google Drive is not authenticated yet; run the headless drive-auth step. The root is compiled provisionally but ingestion stays blocked."
    });
  }
  const clientId = env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("Google Drive credential exists but GOOGLE_OAUTH_CLIENT_ID/GOOGLE_OAUTH_CLIENT_SECRET are missing");
  if (credential.clientId !== clientId) throw new Error("Workspace Drive credential belongs to a different Google OAuth client id");
  const http = new FetchHttpJson();
  const token = new RefreshingAccessToken({
    http,
    client: { clientId, clientSecret, redirectUri: "http://127.0.0.1" },
    refreshToken: credential.refreshToken
  });
  const browser = new GoogleDriveFolderBrowser({ http, token });
  return discoverSourceTopology({
    browser,
    resolver: browser,
    rootId,
    providerKind: "google_drive",
    channels: spec.channels,
    maxDepth: spec.source.maxDepth
  });
}

async function topologyFor(spec: WorkspaceSpecV1, configDir: string, env: Record<string, string | undefined>): Promise<SourceTopology> {
  if (spec.source.kind === "google_drive") return await googleTopology(spec, configDir, env);
  const browser = new LocalFolderBrowser({ root: resolve(spec.source.root) });
  return await discoverSourceTopology({
    browser,
    resolver: browser,
    rootId: LOCAL_ROOT,
    providerKind: "local_folder",
    channels: spec.channels,
    maxDepth: spec.source.maxDepth
  });
}

export async function bootstrapHeadlessWorkspace(input: {
  specPath: string;
  env?: Record<string, string | undefined>;
  now?: string;
}): Promise<HeadlessBootstrapResult> {
  const spec = loadWorkspaceSpecFile(input.specPath);
  const runtimeRoot = resolve(spec.workspace.runtimeRoot);
  const registry = new JsonWorkspaceRegistry(resolve(runtimeRoot, "registry", "workspaces.json"));
  const workspace = new WorkspaceService(registry, runtimeRoot).create({
    workspaceId: spec.workspace.id,
    displayName: spec.workspace.name,
    timezone: spec.workspace.timezone,
    now: input.now ?? new Date().toISOString()
  });
  const layout = workspaceRuntimeLayout(runtimeRoot, spec.workspace.id);
  const topology = await topologyFor(spec, layout.configDir, input.env ?? process.env);
  const config = new JsonDistributionConfigurationStore(resolve(layout.configDir, "distribution.json"));
  const control = new SqliteControlPlaneStore(layout.databasePath);
  try {
    const compile = new WorkspaceSpecCompiler(config, control, layout.configDir).compile(
      spec,
      topology,
      input.now ?? new Date().toISOString(),
      { type: "operator", id: "headless-bootstrap" }
    );
    return { spec, topology, compile, runtimeRoot, databasePath: layout.databasePath, configDir: layout.configDir };
  } finally { control.close(); }
}
