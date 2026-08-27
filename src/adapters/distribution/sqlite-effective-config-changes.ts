import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { EffectiveConfigurationChange, EffectiveConfigurationChangeStatus, EffectiveConfigurationChangeStorePort } from "../../domain/effective-configuration-change.js";

function hash(value:string):string{return createHash("sha256").update(value).digest("hex");}
function iso(value:string):string{const d=new Date(value);if(Number.isNaN(d.getTime()))throw new Error(`Invalid timestamp: ${value}`);return d.toISOString();}
function date(value:string):string{if(!/^\d{4}-\d{2}-\d{2}$/.test(value))throw new Error(`Invalid business date: ${value}`);const d=new Date(`${value}T00:00:00.000Z`);if(d.toISOString().slice(0,10)!==value)throw new Error(`Invalid business date: ${value}`);return value;}
function immutable(change:EffectiveConfigurationChange):string{return JSON.stringify({changeId:change.changeId,kind:change.kind,effectiveBusinessDate:change.effectiveBusinessDate,baseRevision:change.baseRevision,createdAt:change.createdAt,createdBy:change.createdBy,summary:change.summary,payload:change.payload});}

const ALLOWED:Readonly<Record<EffectiveConfigurationChangeStatus,readonly EffectiveConfigurationChangeStatus[]>>={PENDING:["APPLIED","NEEDS_REVIEW","CANCELLED"],APPLIED:[],NEEDS_REVIEW:[],CANCELLED:[]};
export class EffectiveConfigurationChangeConflictError extends Error {}

export class SqliteEffectiveConfigurationChangeStore implements EffectiveConfigurationChangeStorePort {
  private readonly db:DatabaseSync;
  constructor(databasePath:string){
    this.db=new DatabaseSync(databasePath);this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS effective_config_change_versions(
        change_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        status TEXT NOT NULL,
        effective_business_date TEXT NOT NULL,
        change_json TEXT NOT NULL,
        immutable_hash TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        PRIMARY KEY(change_id,version)
      );
      CREATE TABLE IF NOT EXISTS effective_config_change_heads(
        change_id TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        FOREIGN KEY(change_id,version) REFERENCES effective_config_change_versions(change_id,version)
      );
      CREATE INDEX IF NOT EXISTS effective_config_change_due ON effective_config_change_versions(status,effective_business_date,recorded_at);
      CREATE TRIGGER IF NOT EXISTS effective_config_change_versions_no_update BEFORE UPDATE ON effective_config_change_versions BEGIN SELECT RAISE(ABORT,'effective_config_change_versions is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS effective_config_change_versions_no_delete BEFORE DELETE ON effective_config_change_versions BEGIN SELECT RAISE(ABORT,'effective_config_change_versions is append-only'); END;
    `);
  }

  create(change:EffectiveConfigurationChange):EffectiveConfigurationChange{
    if(change.status!=="PENDING")throw new Error("New effective config change must be PENDING");
    const normalized:EffectiveConfigurationChange={...change,effectiveBusinessDate:date(change.effectiveBusinessDate),createdAt:iso(change.createdAt)};
    if(this.get(change.changeId)){
      const existing=this.get(change.changeId)!;
      if(immutable(existing)!==immutable(normalized))throw new EffectiveConfigurationChangeConflictError(`Change ${change.changeId} already exists with different immutable payload`);
      return existing;
    }
    const payload=JSON.stringify(normalized),digest=hash(immutable(normalized));
    this.db.exec("BEGIN IMMEDIATE");
    try{
      this.db.prepare("INSERT INTO effective_config_change_versions(change_id,version,status,effective_business_date,change_json,immutable_hash,recorded_at) VALUES (?,?,?,?,?,?,?)").run(normalized.changeId,1,normalized.status,normalized.effectiveBusinessDate,payload,digest,normalized.createdAt);
      this.db.prepare("INSERT INTO effective_config_change_heads(change_id,version) VALUES (?,1)").run(normalized.changeId);
      this.db.exec("COMMIT");return normalized;
    }catch(error){this.db.exec("ROLLBACK");throw error;}
  }

  get(changeId:string):EffectiveConfigurationChange|null{
    const row=this.db.prepare(`SELECT v.change_json FROM effective_config_change_heads h JOIN effective_config_change_versions v ON v.change_id=h.change_id AND v.version=h.version WHERE h.change_id=?`).get(changeId) as {change_json:string}|undefined;
    return row?JSON.parse(row.change_json) as EffectiveConfigurationChange:null;
  }

  list(status?:EffectiveConfigurationChangeStatus):readonly EffectiveConfigurationChange[]{
    const rows=(status
      ?this.db.prepare(`SELECT v.change_json FROM effective_config_change_heads h JOIN effective_config_change_versions v ON v.change_id=h.change_id AND v.version=h.version WHERE v.status=? ORDER BY v.effective_business_date,v.recorded_at,v.change_id`).all(status)
      :this.db.prepare(`SELECT v.change_json FROM effective_config_change_heads h JOIN effective_config_change_versions v ON v.change_id=h.change_id AND v.version=h.version ORDER BY v.effective_business_date,v.recorded_at,v.change_id`).all()) as {change_json:string}[];
    return rows.map(row=>JSON.parse(row.change_json) as EffectiveConfigurationChange);
  }

  transition(changeId:string,to:Exclude<EffectiveConfigurationChangeStatus,"PENDING">,at:string,reason?:string):EffectiveConfigurationChange{
    const current=this.get(changeId);if(!current)throw new Error(`Unknown effective config change ${changeId}`);
    if(!ALLOWED[current.status].includes(to))throw new EffectiveConfigurationChangeConflictError(`Change ${changeId} cannot transition ${current.status} -> ${to}`);
    const next:EffectiveConfigurationChange={...current,status:to,...(to==="APPLIED"?{appliedAt:iso(at)}:{}),...(reason?{reason}:{})};
    const currentVersion=(this.db.prepare("SELECT version FROM effective_config_change_heads WHERE change_id=?").get(changeId) as {version:number}).version,nextVersion=currentVersion+1,payload=JSON.stringify(next),digest=hash(immutable(next));
    this.db.exec("BEGIN IMMEDIATE");
    try{
      this.db.prepare("INSERT INTO effective_config_change_versions(change_id,version,status,effective_business_date,change_json,immutable_hash,recorded_at) VALUES (?,?,?,?,?,?,?)").run(changeId,nextVersion,to,next.effectiveBusinessDate,payload,digest,iso(at));
      this.db.prepare("UPDATE effective_config_change_heads SET version=? WHERE change_id=? AND version=?").run(nextVersion,changeId,currentVersion);
      this.db.exec("COMMIT");return next;
    }catch(error){this.db.exec("ROLLBACK");throw error;}
  }
  close():void{this.db.close();}
}
