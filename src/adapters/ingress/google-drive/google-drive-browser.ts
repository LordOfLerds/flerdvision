import type { HttpJsonPort, SourceAccessTokenPort, SourceFolderBrowserPort } from "../../../domain/source-folder-ports.js";
import type { SourceFolderCrumb, SourceFolderEntry, SourceFolderListing, SourceFolderPreview } from "../../../domain/source-folder.js";
import { SourceAuthError, SourceBrowseError, isVideoEntry, sortFolderEntries } from "../../../domain/source-folder.js";

const DRIVE_FILES = "https://www.googleapis.com/drive/v3/files";
const FOLDER_MIME = "application/vnd.google-apps.folder";

/** Drive's alias for the user's own top-level folder. */
export const DRIVE_ROOT = "root";

export interface GoogleDriveBrowserConfig {
  http: HttpJsonPort;
  token: SourceAccessTokenPort;
  /** Guards against an accidentally enormous folder; the listing reports when it bit. */
  pageSize?: number;
  /** Deepest breadcrumb we will walk before giving up on ancestry. */
  maxCrumbDepth?: number;
}

interface DriveFile {
  id?: string;
  name?: string;
  mimeType?: string;
  size?: string;
  modifiedTime?: string;
  parents?: string[];
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) throw new SourceBrowseError("Drive returned a non-object response");
  return value as Record<string, unknown>;
}

function entryFrom(file: DriveFile): SourceFolderEntry | null {
  if (!file.id || !file.name) return null;
  const kind = file.mimeType === FOLDER_MIME ? "folder" : "file";
  const entry: SourceFolderEntry = { id: file.id, name: file.name, kind };
  return {
    ...entry,
    ...(file.mimeType ? { mimeType: file.mimeType } : {}),
    ...(file.size ? { sizeBytes: Number(file.size) } : {}),
    ...(file.modifiedTime ? { modifiedAt: file.modifiedTime } : {})
  };
}

/**
 * Reads Drive through the official API rather than by driving its web UI.
 *
 * Social publishing stays browser-native because those platforms offer no usable API for it.
 * Drive does, and an API read is both more stable and less privileged than scraping a logged-in
 * page: the token this uses is scoped read-only.
 */
export class GoogleDriveFolderBrowser implements SourceFolderBrowserPort {
  private readonly pageSize: number;
  private readonly maxCrumbDepth: number;

  constructor(private readonly config: GoogleDriveBrowserConfig) {
    this.pageSize = config.pageSize ?? 200;
    this.maxCrumbDepth = config.maxCrumbDepth ?? 12;
  }

  private async call(url: string): Promise<Record<string, unknown>> {
    const token = await this.config.token.accessToken();
    const response = await this.config.http.getJson(url, {
      Authorization: `Bearer ${token}`,
      Accept: "application/json"
    });
    if (response.status === 401 || response.status === 403) {
      throw new SourceAuthError(`Drive rejected the credential (HTTP ${response.status}). Reconnect the workspace.`);
    }
    if (response.status === 404) throw new SourceBrowseError("Drive folder not found");
    if (response.status < 200 || response.status >= 300) {
      throw new SourceBrowseError(`Drive request failed with HTTP ${response.status}`);
    }
    return asRecord(response.body);
  }

  private async fileMeta(fileId: string): Promise<DriveFile> {
    const url = `${DRIVE_FILES}/${encodeURIComponent(fileId)}?fields=${encodeURIComponent("id,name,mimeType,parents")}&supportsAllDrives=true`;
    return await this.call(url) as DriveFile;
  }

  private async children(folderId: string): Promise<{ files: DriveFile[]; truncated: boolean }> {
    const query = `'${folderId.replace(/'/g, "\\'")}' in parents and trashed = false`;
    const url = `${DRIVE_FILES}?q=${encodeURIComponent(query)}` +
      `&fields=${encodeURIComponent("nextPageToken,files(id,name,mimeType,size,modifiedTime)")}` +
      `&pageSize=${this.pageSize}` +
      `&orderBy=${encodeURIComponent("folder,name")}` +
      `&supportsAllDrives=true&includeItemsFromAllDrives=true`;
    const body = await this.call(url);
    const files = Array.isArray(body.files) ? body.files as DriveFile[] : [];
    return { files, truncated: typeof body.nextPageToken === "string" && body.nextPageToken.length > 0 };
  }

  /** Walks parents upward so the picker can show where it is without the caller tracking state. */
  private async crumbs(folderId: string, folderName: string): Promise<readonly SourceFolderCrumb[]> {
    if (folderId === DRIVE_ROOT) return [{ id: DRIVE_ROOT, name: folderName }];
    const trail: SourceFolderCrumb[] = [{ id: folderId, name: folderName }];
    let cursor = folderId;
    for (let depth = 0; depth < this.maxCrumbDepth; depth += 1) {
      let meta: DriveFile;
      try {
        meta = await this.fileMeta(cursor);
      } catch (error) {
        if (error instanceof SourceAuthError) throw error;
        break; // A folder shared without its ancestry is normal; show the trail we do have.
      }
      const parent = meta.parents?.[0];
      if (!parent) break;
      if (parent === DRIVE_ROOT) {
        trail.unshift({ id: DRIVE_ROOT, name: "Meine Ablage" });
        break;
      }
      let parentMeta: DriveFile;
      try {
        parentMeta = await this.fileMeta(parent);
      } catch {
        break;
      }
      trail.unshift({ id: parent, name: parentMeta.name ?? parent });
      cursor = parent;
    }
    return trail;
  }

  async listFolder(folderId: string): Promise<SourceFolderListing> {
    const id = folderId || DRIVE_ROOT;
    const folderName = id === DRIVE_ROOT ? "Meine Ablage" : (await this.fileMeta(id)).name ?? id;
    const { files, truncated } = await this.children(id);
    const entries = sortFolderEntries(files.map(entryFrom).filter((e): e is SourceFolderEntry => e !== null));
    return { folderId: id, folderName, path: await this.crumbs(id, folderName), entries, truncated };
  }

  async previewFolder(folderId: string): Promise<SourceFolderPreview> {
    const id = folderId || DRIVE_ROOT;
    const { files } = await this.children(id);
    const entries = files.map(entryFrom).filter((e): e is SourceFolderEntry => e !== null).filter((e) => e.kind === "file");
    const videos = entries.filter(isVideoEntry);
    const newest = [...entries].sort((a, b) => String(b.modifiedAt ?? "").localeCompare(String(a.modifiedAt ?? "")))[0];
    return {
      folderId: id,
      videoCount: videos.length,
      otherCount: entries.length - videos.length,
      ...(newest?.name ? { newestName: newest.name } : {}),
      ...(newest?.modifiedAt ? { newestModifiedAt: newest.modifiedAt } : {})
    };
  }
}
