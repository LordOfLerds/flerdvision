import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { RouteTestEvidenceRecord, RouteTestEvidenceStorePort } from "../../domain/route-test-ports.js";

function hash(value:string):string{return createHash("sha256").update(value).digest("hex");}
function iso(value:string):string{const d=new Date(value);if(Number.isNaN(d.getTime()))throw new Error(`Invalid timestamp: ${value}`);return d.toISOString();}

export class RouteTestEvidenceConflictError extends Error {}

export class SqliteRouteTestEvidenceStore implements RouteTestEvidenceStorePort {
  private readonly db:DatabaseSync;
  constructor(databasePath:string){
    this.db=new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS route_test_evidence(
        evidence_id TEXT PRIMARY KEY,
        route_id TEXT NOT NULL,
        test_key TEXT NOT NULL,
        status TEXT NOT NULL,
        checked_at TEXT NOT NULL,
        release_sha TEXT NOT NULL,
        summary TEXT NOT NULL,
        artifact_refs_json TEXT NOT NULL,
        payload_hash TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS route_test_evidence_route_time ON route_test_evidence(route_id,checked_at,evidence_id);
      CREATE INDEX IF NOT EXISTS route_test_evidence_route_key ON route_test_evidence(route_id,test_key,checked_at);
      CREATE TRIGGER IF NOT EXISTS route_test_evidence_no_update BEFORE UPDATE ON route_test_evidence BEGIN SELECT RAISE(ABORT,'route_test_evidence is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS route_test_evidence_no_delete BEFORE DELETE ON route_test_evidence BEGIN SELECT RAISE(ABORT,'route_test_evidence is append-only'); END;
    `);
  }

  record(record:RouteTestEvidenceRecord):RouteTestEvidenceRecord{
    const normalized:RouteTestEvidenceRecord={...record,checkedAt:iso(record.checkedAt),artifactRefs:[...record.artifactRefs]};
    const payload=JSON.stringify(normalized),digest=hash(payload);
    const existing=this.db.prepare("SELECT payload_hash, route_id, test_key, status, checked_at, release_sha, summary, artifact_refs_json FROM route_test_evidence WHERE evidence_id=?")
      .get(normalized.evidenceId) as {payload_hash:string;route_id:string;test_key:string;status:string;checked_at:string;release_sha:string;summary:string;artifact_refs_json:string}|undefined;
    if(existing){
      const reconstructed:RouteTestEvidenceRecord={evidenceId:normalized.evidenceId,routeId:existing.route_id,testKey:existing.test_key as RouteTestEvidenceRecord["testKey"],status:existing.status as RouteTestEvidenceRecord["status"],checkedAt:existing.checked_at,releaseSha:existing.release_sha,summary:existing.summary,artifactRefs:JSON.parse(existing.artifact_refs_json) as string[]};
      if(existing.payload_hash!==digest||JSON.stringify(reconstructed)!==payload)throw new RouteTestEvidenceConflictError(`Route test evidence ${record.evidenceId} already differs`);
      return reconstructed;
    }
    this.db.prepare("INSERT INTO route_test_evidence(evidence_id,route_id,test_key,status,checked_at,release_sha,summary,artifact_refs_json,payload_hash) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(normalized.evidenceId,normalized.routeId,normalized.testKey,normalized.status,normalized.checkedAt,normalized.releaseSha,normalized.summary,JSON.stringify(normalized.artifactRefs),digest);
    return normalized;
  }

  list(routeId:string):readonly RouteTestEvidenceRecord[]{
    const rows=this.db.prepare("SELECT evidence_id,route_id,test_key,status,checked_at,release_sha,summary,artifact_refs_json FROM route_test_evidence WHERE route_id=? ORDER BY checked_at,evidence_id")
      .all(routeId) as {evidence_id:string;route_id:string;test_key:string;status:string;checked_at:string;release_sha:string;summary:string;artifact_refs_json:string}[];
    return rows.map(row=>({evidenceId:row.evidence_id,routeId:row.route_id,testKey:row.test_key as RouteTestEvidenceRecord["testKey"],status:row.status as RouteTestEvidenceRecord["status"],checkedAt:row.checked_at,releaseSha:row.release_sha,summary:row.summary,artifactRefs:JSON.parse(row.artifact_refs_json) as string[]}));
  }

  close():void{this.db.close();}
}
