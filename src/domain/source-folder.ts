import type { Instant } from "./model.js";

/**
 * A browsable view of the source provider, shaped for picking a folder rather than for ingestion.
 *
 * Setup used to ask for a folder id as free text, which meant a typo only surfaced much later as
 * "no content found". Browsing removes the class of error entirely: what cannot be reached cannot
 * be picked.
 */

export type SourceEntryKind = "folder" | "file";

export interface SourceFolderEntry {
  id: string;
  name: string;
  kind: SourceEntryKind;
  mimeType?: string;
  sizeBytes?: number;
  modifiedAt?: Instant;
}

export interface SourceFolderCrumb {
  id: string;
  name: string;
}

export interface SourceFolderListing {
  folderId: string;
  folderName: string;
  /** Root-first trail, so the UI can render a breadcrumb without a second round trip. */
  path: readonly SourceFolderCrumb[];
  entries: readonly SourceFolderEntry[];
  truncated: boolean;
}

/**
 * Enough to prove the connection works before the operator leaves the page. Deliberately a count
 * and a newest item rather than a full inventory -- this is reassurance, not ingestion.
 */
export interface SourceFolderPreview {
  folderId: string;
  videoCount: number;
  otherCount: number;
  newestName?: string;
  newestModifiedAt?: Instant;
}

export class SourceBrowseError extends Error {}
export class SourceAuthError extends SourceBrowseError {}

export function isVideoEntry(entry: SourceFolderEntry): boolean {
  return entry.kind === "file" && typeof entry.mimeType === "string" && entry.mimeType.startsWith("video/");
}

export function sortFolderEntries(entries: readonly SourceFolderEntry[]): readonly SourceFolderEntry[] {
  return [...entries].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
    return a.name.localeCompare(b.name, "de");
  });
}
