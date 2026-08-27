import type { Instant } from "./model.js";

/**
 * @deprecated Historical W9 setup model only. Do not use for new routing.
 *
 * Canonical routing is SourceConnection -> SourceLane -> DistributionRoute. This type remains so
 * existing SQLite rows and migrations can be read and audited. Active Product Setup and Product
 * Control Center must never create new ChannelSourceBinding rows.
 */
export type SourceKind = "google_drive" | "local_folder";

/** @deprecated Read/migration compatibility only. */
export interface ChannelSourceBinding {
  bindingId: string;
  accountId: string;
  source: SourceKind;
  /** Historical opaque provider folder id. */
  folderId: string;
  /** Historical display trail. */
  folderPath: string;
  /** Historical interpretation flag; new configuration lives on SourceLane. */
  interpretSubstructure: boolean;
  enabled: boolean;
}

/** @deprecated Read/migration compatibility only. */
export interface StoredChannelSourceBinding {
  binding: ChannelSourceBinding;
  createdAt: Instant;
  updatedAt: Instant;
}

/** @deprecated Retained so historical storage code can report old conflicts. */
export class ChannelSourceBindingConflictError extends Error {}

/** Historical opaque-id validator also reused by compatibility readers. */
export function assertFolderId(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error("Source folder id cannot be empty");
  if (normalized.length > 512) throw new Error("Source folder id is implausibly long");
  if (/[\s/\\<>|"'`$;]/.test(normalized)) throw new Error(`Unsafe source folder id: ${value}`);
  return normalized;
}

export function normalizeFolderPath(value: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized) throw new Error("Source folder path cannot be empty");
  if (normalized.length > 1024) throw new Error("Source folder path is implausibly long");
  return normalized;
}

/** @deprecated Used only by historical persistence compatibility. */
export function normalizeChannelSourceBinding(binding: ChannelSourceBinding): ChannelSourceBinding {
  return { ...binding, folderId: assertFolderId(binding.folderId), folderPath: normalizeFolderPath(binding.folderPath) };
}

/** @deprecated Used only by historical persistence compatibility. */
export function sameChannelSourceBinding(a: ChannelSourceBinding, b: ChannelSourceBinding): boolean {
  return a.bindingId === b.bindingId && a.accountId === b.accountId && a.source === b.source && a.folderId === b.folderId && a.folderPath === b.folderPath && a.interpretSubstructure === b.interpretSubstructure && a.enabled === b.enabled;
}
