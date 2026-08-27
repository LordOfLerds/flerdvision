import type { ContentAsset } from "./distribution.js";
import type { LocalMediaArtifact } from "./platform-ui.js";

export interface VerifiedMediaCacheRecord {
  cacheKey:string;
  contentId:string;
  mediaFingerprint:string;
  sourceRef:string;
  localPath:string;
  sha256:string;
  sizeBytes:number;
  verifiedAt:string;
  lastAccessedAt:string;
}

export interface VerifiedMediaCachePort {
  get(contentId:string,mediaFingerprint:string):Promise<VerifiedMediaCacheRecord|null>;
  evict(contentId:string,mediaFingerprint:string):Promise<boolean>;
}

export interface VerifiedMediaCacheMaintenanceReport {
  inspected:number;
  evicted:number;
  retained:number;
  errors:readonly string[];
}

export interface VerifiedMediaCacheMaintenancePort {
  evictEligible(assets:readonly ContentAsset[],now:string,retentionHours:number):Promise<VerifiedMediaCacheMaintenanceReport>;
}

export function artifactFromVerifiedCache(record:VerifiedMediaCacheRecord):LocalMediaArtifact{
  return{contentId:record.contentId,sourceRef:record.sourceRef,localPath:record.localPath,sha256:record.sha256,sizeBytes:record.sizeBytes};
}
