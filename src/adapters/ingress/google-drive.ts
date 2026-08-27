import { createHash } from "node:crypto";
import type { SourceObservation } from "../../domain/model.js";
import type { ContentIngressPort } from "../../domain/ports.js";

const FOLDER_MIME = "application/vnd.google-apps.folder";

export interface GoogleDriveItem {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  md5Checksum?: string;
  createdTime?: string;
  modifiedTime?: string;
  version?: string;
  webViewLink?: string;
}

export interface GoogleDriveListPage {
  files: readonly GoogleDriveItem[];
  nextPageToken?: string;
}

export interface GoogleDriveReadClient {
  listChildren(folderId: string, pageToken?: string): Promise<GoogleDriveListPage>;
}

export interface AccessTokenProvider {
  getAccessToken(): Promise<string>;
}

export class GoogleDriveRestReadClient implements GoogleDriveReadClient {
  constructor(
    private readonly tokenProvider: AccessTokenProvider,
    private readonly baseUrl = "https://www.googleapis.com/drive/v3"
  ) {}

  async listChildren(folderId: string, pageToken?: string): Promise<GoogleDriveListPage> {
    const params = new URLSearchParams({
      q: `'${folderId.replaceAll("'", "\\'")}' in parents and trashed = false`,
      fields: "nextPageToken,files(id,name,mimeType,size,md5Checksum,createdTime,modifiedTime,version,webViewLink)",
      pageSize: "1000",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true"
    });
    if (pageToken) params.set("pageToken", pageToken);
    const token = await this.tokenProvider.getAccessToken();
    const response = await fetch(`${this.baseUrl}/files?${params.toString()}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!response.ok) throw new Error(`Google Drive list failed: HTTP ${response.status}`);
    const body = await response.json() as { files?: GoogleDriveItem[]; nextPageToken?: string };
    const page: GoogleDriveListPage = { files: body.files ?? [] };
    if (body.nextPageToken) Object.assign(page, { nextPageToken: body.nextPageToken });
    return page;
  }
}

export interface GoogleDriveFolderIngressConfig {
  sourceId: string;
  rootFolderId: string;
  rootLabel?: string;
  maxDepth?: number;
  acceptedMimePrefixes?: readonly string[];
  acceptedExtensions?: readonly string[];
  observedAt?: () => string;
}

function stableObservationId(sourceId: string, externalObjectId: string): string {
  const hash = createHash("sha256").update(`${sourceId}\n${externalObjectId}`).digest("hex").slice(0, 32);
  return `source:${hash}`;
}

function acceptsFile(item: GoogleDriveItem, config: GoogleDriveFolderIngressConfig): boolean {
  const mimePrefixes = config.acceptedMimePrefixes ?? ["video/"];
  const extensions = (config.acceptedExtensions ?? [".mp4", ".mov", ".m4v", ".webm"])
    .map((value) => value.toLocaleLowerCase("en"));
  const mimeAccepted = mimePrefixes.some((prefix) => item.mimeType.startsWith(prefix));
  const lowerName = item.name.toLocaleLowerCase("en");
  const extensionAccepted = extensions.some((extension) => lowerName.endsWith(extension));
  return mimeAccepted || extensionAccepted;
}

function mediaFingerprint(item: GoogleDriveItem): string | undefined {
  if (item.md5Checksum) return `drive-md5:${item.md5Checksum}`;
  if (item.version && item.size) return `drive-version:${item.version}:size:${item.size}`;
  return undefined;
}

export class GoogleDriveFolderIngressAdapter implements ContentIngressPort {
  constructor(
    private readonly client: GoogleDriveReadClient,
    private readonly config: GoogleDriveFolderIngressConfig
  ) {}

  async observe(): Promise<readonly SourceObservation[]> {
    const observations: SourceObservation[] = [];
    const maxDepth = this.config.maxDepth ?? 8;
    const rootPath = this.config.rootLabel ? [this.config.rootLabel] : [];
    await this.walk(this.config.rootFolderId, rootPath, 0, maxDepth, observations);
    return observations.sort((a, b) => (a.metadata.relativePath ?? "").localeCompare(b.metadata.relativePath ?? ""));
  }

  private async walk(
    folderId: string,
    pathSegments: readonly string[],
    depth: number,
    maxDepth: number,
    out: SourceObservation[]
  ): Promise<void> {
    if (depth > maxDepth) throw new Error(`Google Drive traversal exceeded maxDepth=${maxDepth}`);
    let pageToken: string | undefined;
    do {
      const page = await this.client.listChildren(folderId, pageToken);
      for (const item of page.files) {
        const nextPath = [...pathSegments, item.name];
        if (item.mimeType === FOLDER_MIME) {
          await this.walk(item.id, nextPath, depth + 1, maxDepth, out);
          continue;
        }
        if (!acceptsFile(item, this.config)) continue;
        const metadata: Record<string, string> = {
          relativePath: nextPath.join("/"),
          fileName: item.name,
          mimeType: item.mimeType,
          driveFileId: item.id
        };
        if (item.size) metadata.size = item.size;
        if (item.createdTime) metadata.createdTime = item.createdTime;
        if (item.modifiedTime) metadata.modifiedTime = item.modifiedTime;
        if (item.version) metadata.driveVersion = item.version;
        if (item.webViewLink) metadata.webViewLink = item.webViewLink;
        const observation: SourceObservation = {
          observationId: stableObservationId(this.config.sourceId, item.id),
          sourceId: this.config.sourceId,
          externalObjectId: item.id,
          observedAt: this.config.observedAt?.() ?? new Date().toISOString(),
          locator: `gdrive://file/${item.id}`,
          metadata
        };
        const fingerprint = mediaFingerprint(item);
        if (fingerprint) Object.assign(observation, { mediaFingerprint: fingerprint });
        out.push(observation);
      }
      pageToken = page.nextPageToken;
    } while (pageToken);
  }
}
