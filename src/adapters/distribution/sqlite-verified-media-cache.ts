import { DatabaseSync } from "node:sqlite";
import type { VerifiedMediaCacheEntry, VerifiedMediaCacheStorePort } from "../../domain/verified-media-cache-ports.js";

interface Row {
  content_id:string;
  media_fingerprint:string;
  source_ref:string;
  local_path:string;
  sha256:string;
  size_bytes:number;
  managed:number;
  verified_at:string;
  last_accessed_at:string;
}

function iso(value:string):string{
  const parsed=new Date(value);
  if(Number.isNaN(parsed.getTime()))throw new Error(`Invalid timestamp: ${value}`);
  return parsed.toISOString();
}
function fromRow(row:Row):VerifiedMediaCacheEntry{
  return{
    contentId:row.content_id,
    mediaFingerprint:row.media_fingerprint,
    sourceRef:row.source_ref,
    localPath:row.local_path,
    sha256:row.sha256,
    sizeBytes:row.size_bytes,
    managed:row.managed===1,
    verifiedAt:row.verified_at,
    lastAccessedAt:row.last_accessed_at
  };
}

/** Mutable cache index only. Source identity and publication audit remain in their canonical stores. */
export class SqliteVerifiedMediaCacheStore implements VerifiedMediaCacheStorePort {
  private readonly db:DatabaseSync;
  constructor(databasePath:string){
    this.db=new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS verified_media_cache(
        content_id TEXT NOT NULL,
        media_fingerprint TEXT NOT NULL,
        source_ref TEXT NOT NULL,
        local_path TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        size_bytes INTEGER NOT NULL CHECK(size_bytes>=0),
        managed INTEGER NOT NULL CHECK(managed IN (0,1)),
        verified_at TEXT NOT NULL,
        last_accessed_at TEXT NOT NULL,
        PRIMARY KEY(content_id,media_fingerprint)
      );
      CREATE INDEX IF NOT EXISTS verified_media_cache_access ON verified_media_cache(last_accessed_at);
    `);
  }
  get(contentId:string,mediaFingerprint:string):VerifiedMediaCacheEntry|null{
    const row=this.db.prepare("SELECT * FROM verified_media_cache WHERE content_id=? AND media_fingerprint=?").get(contentId,mediaFingerprint) as Row|undefined;
    return row?fromRow(row):null;
  }
  put(entry:VerifiedMediaCacheEntry):VerifiedMediaCacheEntry{
    const normalized={...entry,verifiedAt:iso(entry.verifiedAt),lastAccessedAt:iso(entry.lastAccessedAt)};
    this.db.prepare(`INSERT INTO verified_media_cache(content_id,media_fingerprint,source_ref,local_path,sha256,size_bytes,managed,verified_at,last_accessed_at)
      VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(content_id,media_fingerprint) DO UPDATE SET
        source_ref=excluded.source_ref,local_path=excluded.local_path,sha256=excluded.sha256,size_bytes=excluded.size_bytes,
        managed=excluded.managed,verified_at=excluded.verified_at,last_accessed_at=excluded.last_accessed_at`)
      .run(normalized.contentId,normalized.mediaFingerprint,normalized.sourceRef,normalized.localPath,normalized.sha256,normalized.sizeBytes,normalized.managed?1:0,normalized.verifiedAt,normalized.lastAccessedAt);
    return normalized;
  }
  touch(contentId:string,mediaFingerprint:string,at:string):void{
    this.db.prepare("UPDATE verified_media_cache SET last_accessed_at=? WHERE content_id=? AND media_fingerprint=?").run(iso(at),contentId,mediaFingerprint);
  }
  remove(contentId:string,mediaFingerprint:string):void{
    this.db.prepare("DELETE FROM verified_media_cache WHERE content_id=? AND media_fingerprint=?").run(contentId,mediaFingerprint);
  }
  list():readonly VerifiedMediaCacheEntry[]{
    return (this.db.prepare("SELECT * FROM verified_media_cache ORDER BY last_accessed_at DESC,content_id,media_fingerprint").all() as Row[]).map(fromRow);
  }
  close():void{this.db.close();}
}
