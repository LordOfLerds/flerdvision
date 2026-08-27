import { createHash } from "node:crypto";
import type { SocialAccount } from "../domain/browser-identity.js";
import type { DistributionConfigurationStorePort, StoredDistributionConfiguration } from "../domain/distribution-ports.js";
import type { EffectiveConfigurationChange, EffectiveConfigurationChangeStorePort } from "../domain/effective-configuration-change.js";
import type { OperatingCalendar } from "../domain/operating-calendar.js";
import type { SchedulingPolicy } from "../domain/scheduling.js";
import { PublishingProgramManagementService, type PublishingProgramDraft } from "./publishing-program-management.js";
import { RhythmCalendarManagementService } from "./rhythm-calendar-management.js";

function id(value:string):string{return createHash("sha256").update(value).digest("hex").slice(0,24);}
function validDate(value:string):string{if(!/^\d{4}-\d{2}-\d{2}$/.test(value))throw new Error(`Invalid effective business date: ${value}`);const d=new Date(`${value}T00:00:00.000Z`);if(d.toISOString().slice(0,10)!==value)throw new Error(`Invalid effective business date: ${value}`);return value;}

export type EffectiveChangeDraft =
  | {kind:"PROGRAM";payload:PublishingProgramDraft}
  | {kind:"RHYTHM";payload:{id:string;policy:SchedulingPolicy}}
  | {kind:"CALENDAR";payload:OperatingCalendar};

export interface EffectiveChangeApplyReport {inspected:number;applied:number;needsReview:number;changeIds:readonly string[];}

class MemoryDistributionStore implements DistributionConfigurationStorePort {
  constructor(private value:StoredDistributionConfiguration){}
  load():StoredDistributionConfiguration{return structuredClone(this.value);}
  save(next:Omit<StoredDistributionConfiguration,"revision">,expectedRevision:number):StoredDistributionConfiguration{
    if(this.value.revision!==expectedRevision)throw new Error(`memory config revision changed: expected ${expectedRevision}, current ${this.value.revision}`);
    this.value={...structuredClone(next),revision:this.value.revision+1};return this.load();
  }
}

function ordered(changes:readonly EffectiveConfigurationChange[]):EffectiveConfigurationChange[]{
  const rank={RHYTHM:0,CALENDAR:1,PROGRAM:2} as const;
  return [...changes].sort((a,b)=>rank[a.kind]-rank[b.kind]||a.createdAt.localeCompare(b.createdAt)||a.changeId.localeCompare(b.changeId));
}

export class EffectiveConfigurationChangeService {
  constructor(private readonly changes:EffectiveConfigurationChangeStorePort,private readonly config:DistributionConfigurationStorePort,private readonly accounts:()=>readonly SocialAccount[]){}

  private preview(draft:EffectiveChangeDraft):{baseRevision:number;summary:string}{
    if(draft.kind==="PROGRAM"){const p=new PublishingProgramManagementService(this.config,this.accounts).preview(draft.payload);return{baseRevision:p.currentRevision,summary:`Publishing program ${p.laneId}: ${p.affectedRouteIds.length} route(s), ${p.requiredAssetCountPerBusinessDate} source asset(s) for preview date.`};}
    const service=new RhythmCalendarManagementService(this.config);
    if(draft.kind==="RHYTHM"){const p=service.previewSchedulePolicy(draft.payload.id,draft.payload.policy);return{baseRevision:p.currentRevision,summary:p.operatorSummary};}
    const p=service.previewOperatingCalendar(draft.payload);return{baseRevision:p.currentRevision,summary:p.operatorSummary};
  }

  schedule(draft:EffectiveChangeDraft,effectiveBusinessDate:string,now:string,createdBy:string):EffectiveConfigurationChange{
    const date=validDate(effectiveBusinessDate),timestamp=new Date(now).toISOString(),preview=this.preview(draft);
    const canonical=JSON.stringify({kind:draft.kind,payload:draft.payload,effectiveBusinessDate:date,baseRevision:preview.baseRevision});
    return this.changes.create({changeId:`config-change:${id(canonical)}`,kind:draft.kind,effectiveBusinessDate:date,baseRevision:preview.baseRevision,createdAt:timestamp,createdBy,status:"PENDING",summary:preview.summary,payload:draft.payload});
  }

  cancel(changeId:string,now:string,reason:string):EffectiveConfigurationChange{return this.changes.transition(changeId,"CANCELLED",now,reason);}

  private applyChangeToMemory(change:EffectiveConfigurationChange,memory:MemoryDistributionStore,timestamp:string):void{
    if(change.kind==="RHYTHM"){
      const payload=change.payload as {id:string;policy:SchedulingPolicy},revision=memory.load().revision;
      new RhythmCalendarManagementService(memory).saveSchedulePolicy(payload.id,payload.policy,revision,timestamp);return;
    }
    if(change.kind==="CALENDAR"){
      const revision=memory.load().revision;new RhythmCalendarManagementService(memory).saveOperatingCalendar(change.payload as OperatingCalendar,revision,timestamp);return;
    }
    const revision=memory.load().revision;new PublishingProgramManagementService(memory,this.accounts).apply(change.payload as PublishingProgramDraft,revision,timestamp);
  }

  applyDue(businessDate:string,now:string):EffectiveChangeApplyReport{
    const date=validDate(businessDate),timestamp=new Date(now).toISOString();
    const due=this.changes.list("PENDING").filter(change=>change.effectiveBusinessDate<=date);
    const groups=new Map<string,EffectiveConfigurationChange[]>();
    for(const change of due){const key=`${change.effectiveBusinessDate}|${change.baseRevision}`;const group=groups.get(key)??[];group.push(change);groups.set(key,group);}
    let applied=0,needsReview=0;const changeIds:string[]=[];

    const sortedGroups=[...groups.entries()].sort(([a],[b])=>a.localeCompare(b));
    for(const [,rawGroup] of sortedGroups){
      const group=ordered(rawGroup);for(const change of group)changeIds.push(change.changeId);
      const baseRevision=group[0]!.baseRevision,current=this.config.load();
      if(current.revision!==baseRevision){
        for(const change of group)this.changes.transition(change.changeId,"NEEDS_REVIEW",timestamp,`configuration revision drifted from ${baseRevision} to ${current.revision}; automatic rebase is forbidden`);
        needsReview+=group.length;continue;
      }
      try{
        const memory=new MemoryDistributionStore(current);
        for(const change of group)this.applyChangeToMemory(change,memory,timestamp);
        const proposed=memory.load();
        this.config.save({
          updatedAt:timestamp,
          config:proposed.config,
          schedulePolicies:proposed.schedulePolicies,
          planningPolicy:proposed.planningPolicy,
          ...(proposed.operatingCalendars?{operatingCalendars:proposed.operatingCalendars}:{}),
          ...(proposed.runtimePolicy?{runtimePolicy:proposed.runtimePolicy}:{})
        },baseRevision);
        for(const change of group)this.changes.transition(change.changeId,"APPLIED",timestamp,`effective change set applied atomically from base revision ${baseRevision}`);
        applied+=group.length;
      }catch(error){
        const reason=`atomic change-set apply failed: ${error instanceof Error?error.message:String(error)}`;
        for(const change of group)this.changes.transition(change.changeId,"NEEDS_REVIEW",timestamp,reason);
        needsReview+=group.length;
      }
    }
    return{inspected:due.length,applied,needsReview,changeIds};
  }
}
