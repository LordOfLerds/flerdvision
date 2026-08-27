import type { StoredDistributionConfiguration } from "../domain/distribution-ports.js";
import type { StoredChannelSourceBinding } from "../domain/source-binding.js";

export type LegacySourceBindingMigrationStatus = "MIGRATED" | "NEEDS_MIGRATION" | "DISABLED";

export interface LegacySourceBindingAuditItem {
  bindingId:string;
  accountId:string;
  source:string;
  folderId:string;
  folderPath:string;
  status:LegacySourceBindingMigrationStatus;
  matchingLaneIds:readonly string[];
  matchingRouteIds:readonly string[];
  reason:string;
}

export interface LegacySourceBindingAudit {
  total:number;
  migrated:number;
  needsMigration:number;
  disabled:number;
  items:readonly LegacySourceBindingAuditItem[];
}

/**
 * Read-only coexistence audit. Legacy bindings never feed planning. They are considered migrated
 * only when a canonical enabled SourceLane for the same technical folder plus a canonical enabled
 * DistributionRoute for the same account exist. Missing posting/copy/schedule choices are never guessed.
 */
export function auditLegacySourceBindings(
  stored:StoredDistributionConfiguration,
  bindings:readonly StoredChannelSourceBinding[]
):LegacySourceBindingAudit{
  const items=bindings.map(({binding}):LegacySourceBindingAuditItem=>{
    if(!binding.enabled)return{
      bindingId:binding.bindingId,accountId:binding.accountId,source:binding.source,folderId:binding.folderId,folderPath:binding.folderPath,status:"DISABLED",
      matchingLaneIds:[],matchingRouteIds:[],reason:"Legacy binding is disabled and has no runtime effect."
    };
    const lanes=stored.config.lanes.filter(lane=>{
      const source=stored.config.sources.find(item=>item.connectionId===lane.connectionId);
      return lane.enabled&&source?.enabled&&source.kind===binding.source&&lane.folderRef===binding.folderId;
    });
    const laneIds=new Set(lanes.map(lane=>lane.laneId));
    const routes=stored.config.routes.filter(route=>route.enabled&&route.accountId===binding.accountId&&laneIds.has(route.laneId));
    if(routes.length>0)return{
      bindingId:binding.bindingId,accountId:binding.accountId,source:binding.source,folderId:binding.folderId,folderPath:binding.folderPath,status:"MIGRATED",
      matchingLaneIds:lanes.map(lane=>lane.laneId).sort(),matchingRouteIds:routes.map(route=>route.routeId).sort(),
      reason:"Canonical SourceLane + DistributionRoute cover this historical relationship; legacy row is audit-only."
    };
    return{
      bindingId:binding.bindingId,accountId:binding.accountId,source:binding.source,folderId:binding.folderId,folderPath:binding.folderPath,status:"NEEDS_MIGRATION",
      matchingLaneIds:lanes.map(lane=>lane.laneId).sort(),matchingRouteIds:[],
      reason:lanes.length===0
        ? "No canonical SourceLane covers this historical folder. Create/confirm the lane, then choose target PostingProfile/Copy/Rhythm in Programs."
        : "A canonical lane exists, but no DistributionRoute for this account. Choose PostingProfile/Copy/Rhythm in Programs; automatic migration is forbidden."
    };
  }).sort((a,b)=>a.status.localeCompare(b.status)||a.accountId.localeCompare(b.accountId)||a.bindingId.localeCompare(b.bindingId));
  return{
    total:items.length,
    migrated:items.filter(item=>item.status==="MIGRATED").length,
    needsMigration:items.filter(item=>item.status==="NEEDS_MIGRATION").length,
    disabled:items.filter(item=>item.status==="DISABLED").length,
    items
  };
}
