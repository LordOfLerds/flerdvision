import type { ControlCenterRuntimeSnapshot } from "../domain/control-center-ports.js";
import type { StoredDistributionConfiguration } from "../domain/distribution-ports.js";
import { effectiveRouteCalendar } from "../domain/operating-calendar.js";
import { DEFAULT_DISTRIBUTION_RUNTIME_POLICY } from "../domain/distribution-operations.js";
import { projectContentDemand } from "./content-demand.js";
import { projectControlCenter } from "./control-center-read-model.js";

export interface PublishingProgramTargetView {
  routeId:string;
  accountId:string;
  accountLabel:string;
  platform:string;
  postingProfileId:string;
  postingProfileLabel:string;
  requirement:"REQUIRED"|"OPTIONAL";
  enabled:boolean;
  readiness:"READY"|"NEEDS_TEST"|"BLOCKED";
  blockers:readonly string[];
  defaultSchedulePolicyId:string;
  effectiveSchedulePolicyId:string;
  operatingCalendarId?:string;
  calendarSource:"ROUTE_DEFAULT"|"WEEKDAY"|"DATE_OVERRIDE";
  activeToday:boolean;
  rhythm:readonly string[];
}

export interface PublishingProgramView {
  programId:string;
  laneId:string;
  laneLabel:string;
  sourceConnectionId:string;
  sourceLabel:string;
  sourceKind:string;
  folderPath:string;
  creatorId?:string;
  activationMode:string;
  activationStatus?:string;
  requiredAssetsToday:number;
  readyAssetsToday:number;
  stabilizingAssetsToday:number;
  blockedAssetsToday:number;
  missingRequiredAssetsToday:number;
  contentStatus:"ENOUGH"|"AT_RISK"|"MISSING"|"NO_REQUIRED_TARGET";
  targets:readonly PublishingProgramTargetView[];
}

export interface PublishingProgramsReadModel {
  businessDate:string;
  sourcePolling:{activeIntervalMinutes:number;idleIntervalMinutes:number;activeWindow:string};
  programs:readonly PublishingProgramView[];
}

/** UX projection only. DistributionRoute remains the canonical persisted relationship. */
export function projectPublishingPrograms(input:{
  stored:StoredDistributionConfiguration;
  runtime:ControlCenterRuntimeSnapshot;
  businessDate:string;
}):PublishingProgramsReadModel{
  const postingProfiles=Object.fromEntries(input.stored.config.postingProfiles.map((item)=>[item.postingProfileId,item]));
  const control=projectControlCenter({
    plan:input.runtime.plan,
    sources:input.stored.config.sources,
    lanes:input.stored.config.lanes,
    routes:input.stored.config.routes,
    postingProfiles,
    accounts:input.runtime.accounts,
    channelReadiness:input.runtime.channelReadiness,
    ...(input.runtime.surfaceReadiness ? { surfaceReadiness: input.runtime.surfaceReadiness } : {}),
    routeTests:input.runtime.routeTests,
    assets:input.runtime.assets
  });
  const routeRows=new Map(control.routes.map((row)=>[row.routeId,row]));
  const demand=new Map(projectContentDemand(input.stored,input.runtime.assets,input.businessDate,input.runtime.plan).lanes.map((item)=>[item.laneId,item]));
  const accounts=new Map(input.runtime.accounts.map((account)=>[account.accountId,account]));
  const sources=new Map(input.stored.config.sources.map((source)=>[source.connectionId,source]));
  const cursors=new Map(input.stored.config.activationCursors.map((cursor)=>[cursor.laneId,cursor]));
  const activation=new Map((input.runtime.sourceActivation??[]).map((status)=>[status.laneId,status]));
  const calendars=Object.fromEntries((input.stored.operatingCalendars??[]).map((item)=>[item.calendarId,item]));

  const programs:PublishingProgramView[]=[];
  for(const lane of input.stored.config.lanes.filter((item)=>item.enabled)){
    const laneRoutes=input.stored.config.routes.filter((route)=>route.laneId===lane.laneId);
    if(laneRoutes.length===0)continue;
    const source=sources.get(lane.connectionId);
    if(!source)continue;
    const laneDemand=demand.get(lane.laneId);
    const targets:PublishingProgramTargetView[]=laneRoutes.map((route)=>{
      const account=accounts.get(route.accountId);
      const profile=postingProfiles[route.postingProfileId];
      const row=routeRows.get(route.routeId);
      const calendar=effectiveRouteCalendar(route,input.businessDate,calendars);
      const schedule=input.stored.schedulePolicies[calendar.schedulePolicyId];
      return{
        routeId:route.routeId,
        accountId:route.accountId,
        accountLabel:account?`@${account.expectedHandle}`:"MISSING ACCOUNT",
        platform:route.platform,
        postingProfileId:route.postingProfileId,
        postingProfileLabel:profile?.displayName??"MISSING PROFILE",
        requirement:route.requirement,
        enabled:route.enabled,
        readiness:row?.readiness??"BLOCKED",
        blockers:row?.blockers??["route_read_model_missing"],
        defaultSchedulePolicyId:route.schedulePolicyId,
        effectiveSchedulePolicyId:calendar.schedulePolicyId,
        ...(route.operatingCalendarId?{operatingCalendarId:route.operatingCalendarId}:{}),
        calendarSource:calendar.source,
        activeToday:calendar.active,
        rhythm:calendar.active?(schedule?.slots.map((slot)=>slot.localTime)??[]):[]
      };
    }).sort((a,b)=>a.platform.localeCompare(b.platform)||a.accountLabel.localeCompare(b.accountLabel)||a.routeId.localeCompare(b.routeId));
    const requiredTargets=targets.filter((target)=>target.enabled&&target.requirement==="REQUIRED"&&target.activeToday);
    const cursor=cursors.get(lane.laneId);
    const status=activation.get(lane.laneId);
    programs.push({
      programId:`program:${lane.laneId}`,
      laneId:lane.laneId,
      laneLabel:lane.displayName,
      sourceConnectionId:lane.connectionId,
      sourceLabel:source.displayName,
      sourceKind:source.kind,
      folderPath:lane.folderPath,
      ...(lane.creatorId?{creatorId:lane.creatorId}:{}),
      activationMode:cursor?.mode??"MISSING",
      ...(status?{activationStatus:status.state}:{}),
      requiredAssetsToday:laneDemand?.requiredAssetCount??0,
      readyAssetsToday:laneDemand?.readyAssetCount??0,
      stabilizingAssetsToday:laneDemand?.stabilizingAssetCount??0,
      blockedAssetsToday:laneDemand?.blockedAssetCount??0,
      missingRequiredAssetsToday:laneDemand?.missingRequiredAssetCount??0,
      contentStatus:requiredTargets.length===0?"NO_REQUIRED_TARGET":laneDemand?.status??"MISSING",
      targets
    });
  }
  const polling=input.stored.runtimePolicy?.sourcePolling??DEFAULT_DISTRIBUTION_RUNTIME_POLICY.sourcePolling;
  return{
    businessDate:input.businessDate,
    sourcePolling:{activeIntervalMinutes:polling.activeIntervalMinutes,idleIntervalMinutes:polling.idleIntervalMinutes,activeWindow:`${polling.activeWindowStartLocal}–${polling.activeWindowEndLocal}`},
    programs:programs.sort((a,b)=>a.laneLabel.localeCompare(b.laneLabel)||a.laneId.localeCompare(b.laneId))
  };
}
