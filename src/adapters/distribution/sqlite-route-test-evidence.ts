import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { RouteTestEvidenceRecord, RouteTestEvidenceStorePort } from "../../domain/route-test-ports.js";

function hash(value:string):string{return createHash("sha256").update(value).digest("hex");}
function iso(value:string):string{const d=new Date(value);if(Number.isNaN(d.getTime()))throw new Error(`Invalid timestamp: ${value}`);return d.toISOString();}

export class RouteTestEvidenceConflictError extends Error {}

interface EvidenceRow {evidence_id:string;route_id:string;test_key:string;status:string;checked_at:string;release_sha:string;surface_fingerprint:string|null;surface_contract_id:string|null;summary:string;artifact_refs_json:string;payload_hash?:string;}
function recordFromRow(row:EvidenceRow):RouteTestEvidenceRecord{return{evidenceId:row.evidence_id,routeId:row.route_id,testKey:row.test_key as RouteTestEvidenceRecord["testKey"],status:row.status as RouteTestEvidenceRecord["status"],checkedAt:row.checked_at,releaseSha:row.release_sha,...(row.surface_fingerprint?{surfaceFingerprint:row.surface_fingerprint}:{}),...(row.surface_contract_id?{surfaceContractId:row.surface_contract_id}:{}),summary:row.summary,artifactRefs:JSON.parse(row.artifact_refs_json) as string[]};}

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
    const columns=this.db.prepare("PRAGMA table_info(route_test_evidence)").all() as Array<{name:string}>;
    if(!columns.some(column=>column.name==="surface_contract_id"))this.db.exec("ALTER TABLE route_test_evidence ADD COLUMN surface_contract_id TEXT");
    // Existing rows stay NULL on purpose: evidence recorded before the surface fingerprint
    // existed cannot prove which surface code it ran against and must read as stale.
    if(!columns.some(column=>column.name==="surface_fingerprint"))this.db.exec("ALTER TABLE route_test_evidence ADD COLUMN surface_fingerprint TEXT");
    this.db.exec("CREATE INDEX IF NOT EXISTS route_test_evidence_surface ON route_test_evidence(route_id,surface_contract_id,test_key,checked_at)");
  }

  record(record:RouteTestEvidenceRecord):RouteTestEvidenceRecord{
    const normalized:RouteTestEvidenceRecord={...record,checkedAt:iso(record.checkedAt),artifactRefs:[...record.artifactRefs]};
    const payload=JSON.stringify(normalized),digest=hash(payload);
    const existing=this.db.prepare("SELECT payload_hash,evidence_id,route_id,test_key,status,checked_at,release_sha,surface_fingerprint,surface_contract_id,summary,artifact_refs_json FROM route_test_evidence WHERE evidence_id=?")
      .get(normalized.evidenceId) as EvidenceRow|undefined;
    if(existing){const reconstructed=recordFromRow(existing);if(existing.payload_hash!==digest||JSON.stringify(reconstructed)!==payload)throw new RouteTestEvidenceConflictError(`Route test evidence ${record.evidenceId} already differs`);return reconstructed;}
    this.db.prepare("INSERT INTO route_test_evidence(evidence_id,route_id,test_key,status,checked_at,release_sha,surface_fingerprint,surface_contract_id,summary,artifact_refs_json,payload_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(normalized.evidenceId,normalized.routeId,normalized.testKey,normalized.status,normalized.checkedAt,normalized.releaseSha,normalized.surfaceFingerprint??null,normalized.surfaceContractId??null,normalized.summary,JSON.stringify(normalized.artifactRefs),digest);
    return normalized;
  }

  list(routeId:string):readonly RouteTestEvidenceRecord[]{
    const rows=this.db.prepare("SELECT evidence_id,route_id,test_key,status,checked_at,release_sha,surface_fingerprint,surface_contract_id,summary,artifact_refs_json FROM route_test_evidence WHERE route_id=? ORDER BY checked_at,evidence_id").all(routeId) as EvidenceRow[];
    return rows.map(recordFromRow);
  }

  close():void{this.db.close();}
}
