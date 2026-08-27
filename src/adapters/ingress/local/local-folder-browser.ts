import { readdirSync, statSync } from "node:fs";
import { resolve, sep, basename, join } from "node:path";
import type { SourceFolderBrowserPort, SourceFolderSelectionResolverPort } from "../../../domain/source-folder-ports.js";
import type { SourceFolderCrumb, SourceFolderEntry, SourceFolderListing, SourceFolderPreview } from "../../../domain/source-folder.js";
import { SourceBrowseError, isVideoEntry, sortFolderEntries } from "../../../domain/source-folder.js";

/** Same alias the Drive adapter uses, so the picker does not care which source it is walking. */
export const LOCAL_ROOT = "root";

const VIDEO_EXTENSIONS: Readonly<Record<string, string>> = {
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".m4v": "video/x-m4v",
  ".webm": "video/webm", ".mkv": "video/x-matroska", ".avi": "video/x-msvideo"
};

function mimeFor(name: string): string | undefined {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return undefined;
  return VIDEO_EXTENSIONS[name.slice(dot).toLowerCase()];
}

/**
 * Folder ids stay opaque tokens, exactly as the domain requires: a path with separators in it
 * would invite callers to interpret or join it. Encoding also keeps absolute paths out of the
 * stored setup selection.
 */
function encodeId(relative: string): string {
  if (!relative || relative === ".") return LOCAL_ROOT;
  return Buffer.from(relative, "utf8").toString("base64url");
}

function decodeId(folderId: string): string {
  if (!folderId || folderId === LOCAL_ROOT) return "";
  try {
    return Buffer.from(folderId, "base64url").toString("utf8");
  } catch {
    throw new SourceBrowseError(`Unreadable folder id: ${folderId}`);
  }
}

export interface LocalFolderBrowserConfig {
  root: string;
  rootLabel?: string;
  maxEntries?: number;
}

export class LocalFolderBrowser implements SourceFolderBrowserPort, SourceFolderSelectionResolverPort {
  private readonly root: string;
  private readonly rootLabel: string;
  private readonly maxEntries: number;

  constructor(config: LocalFolderBrowserConfig) {
    this.root = resolve(config.root);
    this.rootLabel = config.rootLabel ?? basename(this.root) ?? "Quelle";
    this.maxEntries = config.maxEntries ?? 500;
    const stat = this.statOrThrow(this.root);
    if (!stat.isDirectory()) throw new SourceBrowseError(`Source root is not a directory: ${this.root}`);
  }

  private statOrThrow(path: string) {
    try { return statSync(path); }
    catch { throw new SourceBrowseError(`Source path is not readable: ${path}`); }
  }

  /** Confinement is the whole security boundary here, so it is checked on every resolution. */
  private absolute(folderId: string): string {
    const relative = decodeId(folderId);
    if (relative.split(/[\\/]+/).includes("..")) throw new SourceBrowseError(`Unsafe folder id: ${folderId}`);
    const candidate = resolve(this.root, relative);
    if (candidate !== this.root && !candidate.startsWith(`${this.root}${sep}`)) throw new SourceBrowseError(`Folder escaped the configured source root: ${folderId}`);
    return candidate;
  }

  async resolveSelectedFolder(folderId:string):Promise<{folderRef:string}>{
    if(!folderId||folderId===LOCAL_ROOT)throw new SourceBrowseError("The source root itself cannot be used as a lane folder");
    const relative=decodeId(folderId);
    const absolute=this.absolute(folderId);
    if(!this.statOrThrow(absolute).isDirectory())throw new SourceBrowseError(`Selected object is not a directory: ${folderId}`);
    // SourceLaneObservationAdapter joins this relative ref to SourceConnection.rootRef and confines it again.
    return{folderRef:relative};
  }

  private entriesOf(absolute: string): { entries: SourceFolderEntry[]; truncated: boolean } {
    let names: string[];
    try { names = readdirSync(absolute); }
    catch { throw new SourceBrowseError(`Folder is not readable: ${absolute}`); }
    const visible = names.filter((name) => !name.startsWith("."));
    const truncated = visible.length > this.maxEntries;
    const entries: SourceFolderEntry[] = [];
    for (const name of visible.slice(0, this.maxEntries)) {
      let stat;
      try { stat = statSync(join(absolute, name)); }
      catch { continue; }
      const relative = resolve(absolute, name).slice(this.root.length + 1);
      const mime = stat.isDirectory() ? undefined : mimeFor(name);
      entries.push({
        id: encodeId(relative),
        name,
        kind: stat.isDirectory() ? "folder" : "file",
        ...(mime ? { mimeType: mime } : {}),
        ...(stat.isDirectory() ? {} : { sizeBytes: stat.size }),
        modifiedAt: stat.mtime.toISOString()
      });
    }
    return { entries, truncated };
  }

  private crumbs(folderId: string): SourceFolderCrumb[] {
    const relative = decodeId(folderId);
    const trail: SourceFolderCrumb[] = [{ id: LOCAL_ROOT, name: this.rootLabel }];
    if (!relative) return trail;
    let walked = "";
    for (const part of relative.split(sep).filter(Boolean)) {
      walked = walked ? `${walked}${sep}${part}` : part;
      trail.push({ id: encodeId(walked), name: part });
    }
    return trail;
  }

  async listFolder(folderId: string): Promise<SourceFolderListing> {
    const id = folderId || LOCAL_ROOT;
    const absolute = this.absolute(id);
    if (!this.statOrThrow(absolute).isDirectory()) throw new SourceBrowseError(`Not a folder: ${id}`);
    const { entries, truncated } = this.entriesOf(absolute);
    const path = this.crumbs(id);
    return { folderId: id, folderName: path[path.length - 1]!.name, path, entries: sortFolderEntries(entries), truncated };
  }

  async previewFolder(folderId: string): Promise<SourceFolderPreview> {
    const id = folderId || LOCAL_ROOT;
    const { entries } = this.entriesOf(this.absolute(id));
    const files = entries.filter((entry) => entry.kind === "file");
    const videos = files.filter(isVideoEntry);
    const newest = [...files].sort((a, b) => String(b.modifiedAt ?? "").localeCompare(String(a.modifiedAt ?? "")))[0];
    return {
      folderId: id,
      videoCount: videos.length,
      otherCount: files.length - videos.length,
      ...(newest?.name ? { newestName: newest.name } : {}),
      ...(newest?.modifiedAt ? { newestModifiedAt: newest.modifiedAt } : {})
    };
  }
}
