import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { RuntimeCycleLease, RuntimeCycleLeasePort, RuntimeCycleReportStorePort } from "../../domain/runtime-supervisor-ports.js";
import type { RuntimeCycleReport } from "../../application/runtime-supervisor.js";
import type { ControlPlaneStorePort } from "../../domain/control-plane-ports.js";

function iso(value:string):string{const d=new Date(value);if(Number.isNaN(d.getTime()))throw new Error(`Invalid timestamp: ${value}`);return d.toISOString();}
function hash(value:string):string{return createHash("sha256").update(value).digest("hex");}

export class RuntimeCycleAlreadyActiveError extends Error {}
export class RuntimeCycleLeaseLostError extends Error {}
export class RuntimeCycleReportConflictError extends Error {}

export class ControlPlaneRuntimeCycleLeaseAdapter implements RuntimeCycleLeasePort {
  constructor(
    private readonly store:ControlPlaneStorePort,
    private readonly workspaceId:string,
    private readonly ttlSeconds:number=180,
    private readonly clock:()=>string=()=>new Date().toISOString()
  ){}

  acquire(ownerId:string,now:string):RuntimeCycleLease{
    const resourceKey=`runtime-cycle:${this.workspaceId}`;
    const actor={type:"worker",id:ownerId} as const;
    const acquired=this.store.acquireLease(resourceKey,ownerId,iso(now),this.ttlSeconds,actor);
    if(!acquired)throw new RuntimeCycleAlreadyActiveError(`Runtime cycle is already active for workspace ${this.workspaceId}`);
    let released=false;
    return{
      heartbeat:(at:string)=>{
        if(released)throw new RuntimeCycleLeaseLostError(`Runtime cycle lease ${resourceKey} is already released`);
        const beat=this.store.heartbeatLease(resourceKey,ownerId,iso(at),this.ttlSeconds,actor);
        if(!beat)throw new RuntimeCycleLeaseLostError(`Runtime cycle lease ${resourceKey} was lost`);
      },
      release:(at?:string)=>{
        if(released)return;
        const releasedOk=this.store.releaseLease(resourceKey,ownerId,iso(at??this.clock()),actor);
        released=true;
        if(!releasedOk)throw new RuntimeCycleLeaseLostError(`Runtime cycle lease ${resourceKey} could not be released by ${ownerId}`);
      }
    };
  }
}

interface ReportRow { cycle_id:string; report_json:string; payload_hash:string; started_at:string; finished_at:string; }

export class SqliteRuntimeCycleReportStore implements RuntimeCycleReportStorePort {
  private readonly db:DatabaseSync;
  constructor(databasePath:string,private readonly workspaceId:string){
    if(!workspaceId.trim())throw new Error("Runtime cycle report workspaceId is required");
    this.db=new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runtime_cycle_reports(
        cycle_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT NOT NULL,
        business_date TEXT NOT NULL,
        healthy INTEGER NOT NULL,
        report_json TEXT NOT NULL,
        payload_hash TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS runtime_cycle_reports_time ON runtime_cycle_reports(started_at DESC);
      CREATE TRIGGER IF NOT EXISTS runtime_cycle_reports_no_update BEFORE UPDATE ON runtime_cycle_reports BEGIN SELECT RAISE(ABORT,'runtime_cycle_reports is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS runtime_cycle_reports_no_delete BEFORE DELETE ON runtime_cycle_reports BEGIN SELECT RAISE(ABORT,'runtime_cycle_reports is append-only'); END;
    `);
  }

  record(report:RuntimeCycleReport):void{
    const payload=JSON.stringify(report),digest=hash(payload);
    const existing=this.db.prepare("SELECT cycle_id,report_json,payload_hash,started_at,finished_at FROM runtime_cycle_reports WHERE cycle_id=?").get(report.cycleId) as ReportRow|undefined;
    if(existing){
      if(existing.payload_hash!==digest||existing.report_json!==payload)throw new RuntimeCycleReportConflictError(`Runtime cycle ${report.cycleId} already has different report payload`);
      return;
    }
    this.db.prepare("INSERT INTO runtime_cycle_reports(cycle_id,workspace_id,owner_id,started_at,finished_at,business_date,healthy,report_json,payload_hash) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(report.cycleId,this.workspaceId,report.ownerId,iso(report.startedAt),iso(report.finishedAt),report.businessDate,report.healthy?1:0,payload,digest);
  }

  latest(limit:number=20):readonly RuntimeCycleReport[]{
    if(!Number.isInteger(limit)||limit<1||limit>500)throw new Error("Runtime cycle report limit must be 1..500");
    const rows=this.db.prepare("SELECT report_json FROM runtime_cycle_reports WHERE workspace_id=? ORDER BY started_at DESC,cycle_id DESC LIMIT ?").all(this.workspaceId,limit) as {report_json:string}[];
    return rows.map(row=>JSON.parse(row.report_json) as RuntimeCycleReport);
  }

  close():void{this.db.close();}
}
