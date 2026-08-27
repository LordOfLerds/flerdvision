import type { DistributionConfigurationStorePort, StoredDistributionConfiguration } from "../domain/distribution-ports.js";
import type { OperatingCalendar } from "../domain/operating-calendar.js";
import { assertOperatingCalendarCatalog, assertRouteCalendarReference } from "../domain/operating-calendar.js";
import type { SchedulingPolicy } from "../domain/scheduling.js";

export interface RhythmCalendarImpact {
  currentRevision:number;
  changeKind:"SCHEDULE_POLICY"|"OPERATING_CALENDAR";
  changedId:string;
  affectedRouteIds:readonly string[];
  invalidateFutureDailyPlans:boolean;
  requireRouteRetest:false;
  preserveCommittedDeliveries:true;
  preserveVerifiedPublications:true;
  operatorSummary:string;
  next:StoredDistributionConfiguration;
}

function assertSchedulePolicy(id:string,policy:SchedulingPolicy):void{
  if(!id.trim())throw new Error("Schedule policy id cannot be empty");
  if(!policy.timeZone.trim())throw new Error(`Schedule policy ${id} requires a timezone`);
  if(!Number.isInteger(policy.windowMinutes)||policy.windowMinutes<0)throw new Error(`Schedule policy ${id} has invalid windowMinutes`);
  if(!Number.isInteger(policy.maxPerAccountPerBusinessDate)||policy.maxPerAccountPerBusinessDate<1)throw new Error(`Schedule policy ${id} has invalid daily cap`);
  if(!Number.isInteger(policy.minimumSpacingMinutes)||policy.minimumSpacingMinutes<0)throw new Error(`Schedule policy ${id} has invalid minimum spacing`);
  const keys=policy.slots.map((slot)=>slot.key);
  if(new Set(keys).size!==keys.length)throw new Error(`Schedule policy ${id} has duplicate slot keys`);
  const times=policy.slots.map((slot)=>slot.localTime);
  if(new Set(times).size!==times.length)throw new Error(`Schedule policy ${id} has duplicate slot times`);
  for(const slot of policy.slots){
    if(!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(slot.localTime))throw new Error(`Schedule policy ${id} has invalid local time ${slot.localTime}`);
    if(!slot.key.trim())throw new Error(`Schedule policy ${id} has an empty slot key`);
  }
}

export class RhythmCalendarManagementService {
  constructor(private readonly store:DistributionConfigurationStorePort){}

  previewSchedulePolicy(schedulePolicyId:string,policy:SchedulingPolicy):RhythmCalendarImpact{
    assertSchedulePolicy(schedulePolicyId,policy);
    const current=this.store.load();
    const nextPolicies={...current.schedulePolicies,[schedulePolicyId]:policy};
    assertOperatingCalendarCatalog(current.operatingCalendars??[],nextPolicies);
    const affected=current.config.routes.filter((route)=>
      route.schedulePolicyId===schedulePolicyId||
      (current.operatingCalendars??[]).some((calendar)=>
        calendar.calendarId===route.operatingCalendarId&&(
          calendar.weekdayRules.some((rule)=>rule.schedulePolicyId===schedulePolicyId)||
          calendar.dateOverrides.some((override)=>override.schedulePolicyId===schedulePolicyId)
        )
      )
    ).map((route)=>route.routeId).sort();
    const next:StoredDistributionConfiguration={...current,schedulePolicies:nextPolicies};
    return{
      currentRevision:current.revision,
      changeKind:"SCHEDULE_POLICY",
      changedId:schedulePolicyId,
      affectedRouteIds:affected,
      invalidateFutureDailyPlans:affected.length>0,
      requireRouteRetest:false,
      preserveCommittedDeliveries:true,
      preserveVerifiedPublications:true,
      operatorSummary:affected.length>0
        ?`${affected.length} route(s) use this rhythm directly or through a calendar. Future uncommitted slots must be replanned; existing reservations stay fixed.`
        :"No active route currently uses this rhythm.",
      next
    };
  }

  saveSchedulePolicy(schedulePolicyId:string,policy:SchedulingPolicy,expectedRevision:number,now:string):RhythmCalendarImpact{
    const preview=this.previewSchedulePolicy(schedulePolicyId,policy);
    if(preview.currentRevision!==expectedRevision)throw new Error(`Rhythm preview is stale: expected ${expectedRevision}, current ${preview.currentRevision}`);
    const stored=this.store.save({
      updatedAt:new Date(now).toISOString(),
      config:preview.next.config,
      schedulePolicies:preview.next.schedulePolicies,
      operatingCalendars:preview.next.operatingCalendars,
      planningPolicy:preview.next.planningPolicy,
      ...(preview.next.runtimePolicy?{runtimePolicy:preview.next.runtimePolicy}:{})
    },expectedRevision);
    return{...preview,currentRevision:stored.revision,next:stored};
  }

  previewOperatingCalendar(calendar:OperatingCalendar):RhythmCalendarImpact{
    const current=this.store.load();
    const map=new Map((current.operatingCalendars??[]).map((item)=>[item.calendarId,item]));
    map.set(calendar.calendarId,calendar);
    const calendars=[...map.values()];
    assertOperatingCalendarCatalog(calendars,current.schedulePolicies);
    for(const route of current.config.routes)assertRouteCalendarReference(route,calendars);
    const affected=current.config.routes.filter((route)=>route.operatingCalendarId===calendar.calendarId).map((route)=>route.routeId).sort();
    const next:StoredDistributionConfiguration={...current,operatingCalendars:calendars};
    return{
      currentRevision:current.revision,
      changeKind:"OPERATING_CALENDAR",
      changedId:calendar.calendarId,
      affectedRouteIds:affected,
      invalidateFutureDailyPlans:affected.length>0,
      requireRouteRetest:false,
      preserveCommittedDeliveries:true,
      preserveVerifiedPublications:true,
      operatorSummary:affected.length>0
        ?`${affected.length} route(s) use this calendar. Future uncommitted slots follow the new weekday/date rules; committed reservations remain unchanged.`
        :"No route currently uses this operating calendar.",
      next
    };
  }

  saveOperatingCalendar(calendar:OperatingCalendar,expectedRevision:number,now:string):RhythmCalendarImpact{
    const preview=this.previewOperatingCalendar(calendar);
    if(preview.currentRevision!==expectedRevision)throw new Error(`Calendar preview is stale: expected ${expectedRevision}, current ${preview.currentRevision}`);
    const stored=this.store.save({
      updatedAt:new Date(now).toISOString(),
      config:preview.next.config,
      schedulePolicies:preview.next.schedulePolicies,
      operatingCalendars:preview.next.operatingCalendars,
      planningPolicy:preview.next.planningPolicy,
      ...(preview.next.runtimePolicy?{runtimePolicy:preview.next.runtimePolicy}:{})
    },expectedRevision);
    return{...preview,currentRevision:stored.revision,next:stored};
  }
}
