import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { RouteTestReadiness } from "../../application/control-center-read-model.js";
import type {
  DistributionRuntimeStateStorePort,
  StoredContentAssetRevision,
  StoredDailyPlanRevision,
  StoredRouteTestReadinessRevision
} from "../../domain/distribution-runtime-ports.js";
import type { ContentAsset, DailyPlan } from "../../domain/distribution.js";

interface PlanRow { plan_id:string; business_date:string; plan_json:string; semantic_hash:string; recorded_at:string; }
interface AssetRow { asset_id:string; version:number; asset_json:string; payload_hash:string; recorded_at:string; }
interface RouteTestRow { route_id:string; version:number; readiness_json:string; payload_hash:string; recorded_at:string; }

function iso(value:string):string {
  const parsed=new Date(value);
  if(Number.isNaN(parsed.getTime())) throw new Error(`Invalid timestamp: ${value}`);
  return parsed.toISOString();
}
function hash(value:string):string { return createHash("sha256").update(value).digest("hex"); }
function json(value:unknown):string { return JSON.stringify(value); }
function semanticPlan(plan:DailyPlan):string {
  return json({ planId:plan.planId,businessDate:plan.businessDate,deliveries:plan.deliveries,gaps:plan.gaps,backlog:plan.backlog });
}
function immutableAsset(asset:ContentAsset):string {
  return json({
    assetId:asset.assetId,contentId:asset.contentId,laneId:asset.laneId,creatorId:asset.creatorId,
    sourceObservationId:asset.sourceObservationId,sourceRef:asset.sourceRef,externalObjectId:asset.externalObjectId,
    filename:asset.filename,mediaFingerprint:asset.mediaFingerprint,observedAt:asset.observedAt
  });
}

const ALLOWED_ASSET_TRANSITIONS:Readonly<Record<ContentAsset["state"],readonly ContentAsset["state"][]>>={
  OBSERVED:["OBSERVED","STABILIZING","READY","BLOCKED"],
  STABILIZING:["STABILIZING","READY","BLOCKED"],
  READY:["READY","COMPLETE","BLOCKED"],
  BLOCKED:["BLOCKED"],
  COMPLETE:["COMPLETE"]
};

export class DistributionRuntimeConflictError extends Error {}

export class SqliteDistributionRuntimeStateStore implements DistributionRuntimeStateStorePort {
  private readonly db:DatabaseSync;

  constructor(databasePath:string){
    this.db=new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS distribution_daily_plan_versions(
        plan_id TEXT PRIMARY KEY,
        business_date TEXT NOT NULL,
        plan_json TEXT NOT NULL,
        semantic_hash TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS distribution_daily_plan_date ON distribution_daily_plan_versions(business_date,recorded_at);
      CREATE TABLE IF NOT EXISTS distribution_daily_plan_heads(
        business_date TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL REFERENCES distribution_daily_plan_versions(plan_id),
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS distribution_content_asset_versions(
        asset_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        asset_json TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        PRIMARY KEY(asset_id,version)
      );
      CREATE TABLE IF NOT EXISTS distribution_content_asset_heads(
        asset_id TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        FOREIGN KEY(asset_id,version) REFERENCES distribution_content_asset_versions(asset_id,version)
      );

      CREATE TABLE IF NOT EXISTS distribution_route_test_versions(
        route_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        readiness_json TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        PRIMARY KEY(route_id,version)
      );
      CREATE TABLE IF NOT EXISTS distribution_route_test_heads(
        route_id TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        FOREIGN KEY(route_id,version) REFERENCES distribution_route_test_versions(route_id,version)
      );

      CREATE TRIGGER IF NOT EXISTS distribution_daily_plan_versions_no_update BEFORE UPDATE ON distribution_daily_plan_versions BEGIN SELECT RAISE(ABORT,'distribution_daily_plan_versions is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS distribution_daily_plan_versions_no_delete BEFORE DELETE ON distribution_daily_plan_versions BEGIN SELECT RAISE(ABORT,'distribution_daily_plan_versions is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS distribution_content_asset_versions_no_update BEFORE UPDATE ON distribution_content_asset_versions BEGIN SELECT RAISE(ABORT,'distribution_content_asset_versions is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS distribution_content_asset_versions_no_delete BEFORE DELETE ON distribution_content_asset_versions BEGIN SELECT RAISE(ABORT,'distribution_content_asset_versions is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS distribution_route_test_versions_no_update BEFORE UPDATE ON distribution_route_test_versions BEGIN SELECT RAISE(ABORT,'distribution_route_test_versions is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS distribution_route_test_versions_no_delete BEFORE DELETE ON distribution_route_test_versions BEGIN SELECT RAISE(ABORT,'distribution_route_test_versions is append-only'); END;
    `);
  }

  putDailyPlan(plan:DailyPlan,recordedAt:string):{created:boolean;record:StoredDailyPlanRevision}{
    const at=iso(recordedAt),payload=json(plan),semanticHash=hash(semanticPlan(plan));
    const existing=this.db.prepare("SELECT * FROM distribution_daily_plan_versions WHERE plan_id=?").get(plan.planId) as PlanRow|undefined;
    if(existing){
      const parsed=JSON.parse(existing.plan_json) as DailyPlan;
      if(existing.semantic_hash!==semanticHash||hash(semanticPlan(parsed))!==semanticHash){
        throw new DistributionRuntimeConflictError(`DailyPlan ${plan.planId} has different semantic payload`);
      }
      this.db.prepare("INSERT INTO distribution_daily_plan_heads(business_date,plan_id,updated_at) VALUES (?,?,?) ON CONFLICT(business_date) DO UPDATE SET plan_id=excluded.plan_id,updated_at=excluded.updated_at").run(plan.businessDate,plan.planId,at);
      return{created:false,record:{plan:parsed,recordedAt:existing.recorded_at}};
    }
    this.db.exec("BEGIN IMMEDIATE");
    try{
      this.db.prepare("INSERT INTO distribution_daily_plan_versions(plan_id,business_date,plan_json,semantic_hash,recorded_at) VALUES (?,?,?,?,?)").run(plan.planId,plan.businessDate,payload,semanticHash,at);
      this.db.prepare("INSERT INTO distribution_daily_plan_heads(business_date,plan_id,updated_at) VALUES (?,?,?) ON CONFLICT(business_date) DO UPDATE SET plan_id=excluded.plan_id,updated_at=excluded.updated_at").run(plan.businessDate,plan.planId,at);
      this.db.exec("COMMIT");
      return{created:true,record:{plan,recordedAt:at}};
    }catch(error){this.db.exec("ROLLBACK");throw error;}
  }

  latestDailyPlan(businessDate:string):StoredDailyPlanRevision|null{
    const row=this.db.prepare(`SELECT v.* FROM distribution_daily_plan_heads h JOIN distribution_daily_plan_versions v ON v.plan_id=h.plan_id WHERE h.business_date=?`).get(businessDate) as PlanRow|undefined;
    return row?{plan:JSON.parse(row.plan_json) as DailyPlan,recordedAt:row.recorded_at}:null;
  }

  listDailyPlans(businessDate?:string):readonly StoredDailyPlanRevision[]{
    const rows=(businessDate
      ? this.db.prepare("SELECT * FROM distribution_daily_plan_versions WHERE business_date=? ORDER BY recorded_at,plan_id").all(businessDate)
      : this.db.prepare("SELECT * FROM distribution_daily_plan_versions ORDER BY business_date,recorded_at,plan_id").all()) as PlanRow[];
    return rows.map(row=>({plan:JSON.parse(row.plan_json) as DailyPlan,recordedAt:row.recorded_at}));
  }

  putAsset(asset:ContentAsset,recordedAt:string):{created:boolean;record:StoredContentAssetRevision}{
    const at=iso(recordedAt),payload=json(asset),digest=hash(payload),current=this.getAsset(asset.assetId);
    if(current){
      if(json(current.asset)===payload) return{created:false,record:current};
      if(immutableAsset(current.asset)!==immutableAsset(asset)) throw new DistributionRuntimeConflictError(`Asset ${asset.assetId} immutable source identity changed`);
      if(!ALLOWED_ASSET_TRANSITIONS[current.asset.state].includes(asset.state)) throw new DistributionRuntimeConflictError(`Asset ${asset.assetId} cannot transition ${current.asset.state} -> ${asset.state}`);
    }
    const version=(current?.version??0)+1;
    this.db.exec("BEGIN IMMEDIATE");
    try{
      this.db.prepare("INSERT INTO distribution_content_asset_versions(asset_id,version,asset_json,payload_hash,recorded_at) VALUES (?,?,?,?,?)").run(asset.assetId,version,payload,digest,at);
      this.db.prepare("INSERT INTO distribution_content_asset_heads(asset_id,version) VALUES (?,?) ON CONFLICT(asset_id) DO UPDATE SET version=excluded.version").run(asset.assetId,version);
      this.db.exec("COMMIT");
      return{created:true,record:{asset,version,recordedAt:at}};
    }catch(error){this.db.exec("ROLLBACK");throw error;}
  }

  getAsset(assetId:string):StoredContentAssetRevision|null{
    const row=this.db.prepare(`SELECT v.* FROM distribution_content_asset_heads h JOIN distribution_content_asset_versions v ON v.asset_id=h.asset_id AND v.version=h.version WHERE h.asset_id=?`).get(assetId) as AssetRow|undefined;
    return row?{asset:JSON.parse(row.asset_json) as ContentAsset,version:row.version,recordedAt:row.recorded_at}:null;
  }

  listAssets():readonly StoredContentAssetRevision[]{
    const rows=this.db.prepare(`SELECT v.* FROM distribution_content_asset_heads h JOIN distribution_content_asset_versions v ON v.asset_id=h.asset_id AND v.version=h.version ORDER BY v.asset_id`).all() as AssetRow[];
    return rows.map(row=>({asset:JSON.parse(row.asset_json) as ContentAsset,version:row.version,recordedAt:row.recorded_at}));
  }

  putRouteTestReadiness(readiness:RouteTestReadiness,recordedAt:string):{created:boolean;record:StoredRouteTestReadinessRevision}{
    const at=iso(recordedAt),payload=json(readiness),digest=hash(payload),current=this.latestRouteTestReadiness(readiness.routeId);
    if(current&&json(current.readiness)===payload)return{created:false,record:current};
    const version=(current?.version??0)+1;
    this.db.exec("BEGIN IMMEDIATE");
    try{
      this.db.prepare("INSERT INTO distribution_route_test_versions(route_id,version,readiness_json,payload_hash,recorded_at) VALUES (?,?,?,?,?)").run(readiness.routeId,version,payload,digest,at);
      this.db.prepare("INSERT INTO distribution_route_test_heads(route_id,version) VALUES (?,?) ON CONFLICT(route_id) DO UPDATE SET version=excluded.version").run(readiness.routeId,version);
      this.db.exec("COMMIT");
      return{created:true,record:{readiness,version,recordedAt:at}};
    }catch(error){this.db.exec("ROLLBACK");throw error;}
  }

  latestRouteTestReadiness(routeId:string):StoredRouteTestReadinessRevision|null{
    const row=this.db.prepare(`SELECT v.* FROM distribution_route_test_heads h JOIN distribution_route_test_versions v ON v.route_id=h.route_id AND v.version=h.version WHERE h.route_id=?`).get(routeId) as RouteTestRow|undefined;
    return row?{readiness:JSON.parse(row.readiness_json) as RouteTestReadiness,version:row.version,recordedAt:row.recorded_at}:null;
  }

  listRouteTestReadiness():readonly StoredRouteTestReadinessRevision[]{
    const rows=this.db.prepare(`SELECT v.* FROM distribution_route_test_heads h JOIN distribution_route_test_versions v ON v.route_id=h.route_id AND v.version=h.version ORDER BY v.route_id`).all() as RouteTestRow[];
    return rows.map(row=>({readiness:JSON.parse(row.readiness_json) as RouteTestReadiness,version:row.version,recordedAt:row.recorded_at}));
  }

  close():void{this.db.close();}
}
