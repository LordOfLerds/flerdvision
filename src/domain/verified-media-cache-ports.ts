import type { ContentItem } from "./model.js";
import type { LocalMediaArtifact } from "./platform-ui.js";

export interface VerifiedMediaCacheEntry {
  contentId: string;
  mediaFingerprint: string;
  sourceRef: string;
  localPath: string;
  sha256: string;
  sizeBytes: number;
  managed: boolean;
  verifiedAt: string;
  lastAccessedAt: string;
}

export interface VerifiedMediaCacheStorePort {
  get(contentId: string, mediaFingerprint: string): VerifiedMediaCacheEntry | null;
  put(entry: VerifiedMediaCacheEntry): VerifiedMediaCacheEntry;
  touch(contentId: string, mediaFingerprint: string, at: string): void;
  remove(contentId: string, mediaFingerprint: string): void;
  list(): readonly VerifiedMediaCacheEntry[];
}

export interface VerifiedMediaCachePort {
  materialize(content: ContentItem): Promise<LocalMediaArtifact>;
  release?(artifact: LocalMediaArtifact): Promise<void>;
  evict(contentId: string, mediaFingerprint: string): Promise<boolean>;
  sweep(olderThan: string): Promise<{ removed: number; retained: number }>;
}
