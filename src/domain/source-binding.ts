import type { Instant } from "./model.js";

/**
 * Which source folder feeds which social channel.
 *
 * The setup UI used to hold a single Drive root per workspace, which made "this folder belongs to
 * that one account" impossible to express. A binding is the per-channel mapping instead.
 *
 * Cardinality is deliberately asymmetric:
 *  - an account watches EXACTLY ONE folder, so an arriving file has one unambiguous destination;
 *  - a folder MAY feed several accounts, which is how the same clip cross-posts to Instagram
 *    and TikTok without being uploaded to Drive twice.
 */

/**
 * Where a channel's material comes from. A mounted cloud folder (Google Drive for Desktop,
 * OneDrive, Dropbox) is an ordinary directory, so it needs no API credential at all -- the same
 * picker and the same bindings work either way.
 */
export type SourceKind = "google_drive" | "local_folder";

export interface ChannelSourceBinding {
  bindingId: string;
  accountId: string;
  source: SourceKind;
  /** Opaque provider id. Never parsed, never used to build a path. */
  folderId: string;
  /** Human-readable trail shown in the UI, e.g. "Meine Ablage / Flerdvision / Instagram Luca". */
  folderPath: string;
  /**
   * Off: everything in the folder belongs to this channel.
   * On: creator/week/day subfolders are additionally interpreted for scheduling.
   * The flag lives on the binding, not on the workspace, so one channel can use the simple case
   * while another uses the structured one.
   */
  interpretSubstructure: boolean;
  enabled: boolean;
}

export interface StoredChannelSourceBinding {
  binding: ChannelSourceBinding;
  createdAt: Instant;
  updatedAt: Instant;
}

export class ChannelSourceBindingConflictError extends Error {}

export function assertFolderId(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error("Source folder id cannot be empty");
  if (normalized.length > 512) throw new Error("Source folder id is implausibly long");
  // A provider id is an opaque token. Anything that looks like a path or a shell fragment is a
  // sign the caller passed something it interpreted, which is exactly what must not happen here.
  if (/[\s/\\<>|"'`$;]/.test(normalized)) throw new Error(`Unsafe source folder id: ${value}`);
  return normalized;
}

export function normalizeFolderPath(value: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized) throw new Error("Source folder path cannot be empty");
  if (normalized.length > 1024) throw new Error("Source folder path is implausibly long");
  return normalized;
}

export function normalizeChannelSourceBinding(binding: ChannelSourceBinding): ChannelSourceBinding {
  return {
    ...binding,
    folderId: assertFolderId(binding.folderId),
    folderPath: normalizeFolderPath(binding.folderPath)
  };
}

export function sameChannelSourceBinding(a: ChannelSourceBinding, b: ChannelSourceBinding): boolean {
  return a.bindingId === b.bindingId &&
    a.accountId === b.accountId &&
    a.source === b.source &&
    a.folderId === b.folderId &&
    a.folderPath === b.folderPath &&
    a.interpretSubstructure === b.interpretSubstructure &&
    a.enabled === b.enabled;
}
