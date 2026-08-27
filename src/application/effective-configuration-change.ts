import { createHash } from "node:crypto";
import type { SocialAccount } from "../domain/browser-identity.js";
import type { DistributionConfigurationStorePort } from "../domain/distribution-ports.js";
import type { EffectiveConfigurationChange, EffectiveConfigurationChangeKind, EffectiveConfigurationChangeStorePort } from "../domain/effective-configuration-change.js";
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

export interface EffectiveChangeApplyReport {
  inspected:number;
  applied:number;
  needsReview:number;
  changeIds:readonly string[];
}

export class EffectiveConfigurationChangeService {
  constructor(
    private readonly changes:EffectiveConfigurationChangeStorePort,
    private readonly config:DistributionConfigurationStorePort,
    private readonly accounts:()=>readonly SocialAccount[]
  ){}

  private preview(draft:EffectiveChangeDraft):{baseRevision:number;summary:string}{
    if(draft.kind==="PROGRAM"){
      const p=new PublishingProgramManagementService(this.config,this.accounts).preview(draft.payload);
      return{baseRevision:p.currentRevision,summary:`Publishing program ${p.laneId}: ${p.affectedRouteIds.length} route(s), ${p.requiredAssetCountPerBusinessDate} source asset(s) for preview date.`};
    }
    const service=new RhythmCalendarManagementService(this.config);
    if(draft.kind==="RHYTHM"){
      const p=service.previewSchedulePolicy(draft.payload.id,draft.payload.policy);
      return{baseRevision:p.currentRevision,summary:p.operatorSummary};
    }
    const p=service.previewOperatingCalendar(draft.payload);
    return{baseRevision:p.currentRevision,summary:p.operatorSummary};
  }

  schedule(draft:EffectiveChangeDraft,effectiveBusinessDate:string,now:string,createdBy:string):EffectiveConfigurationChange{
    const date=validDate(effectiveBusinessDate),timestamp=new Date(now).toISOString(),preview=this.preview(draft);
    const canonical=JSON.stringify({kind:draft.kind,payload:draft.payload,effectiveBusinessDate:date,baseRevision:preview.baseRevision});
    return this.changes.create({
      changeId:`config-change:${id(canonical)}`,
      kind:draft.kind,
      effectiveBusinessDate:date,
      baseRevision:preview.baseRevision,
      createdAt:timestamp,
      createdBy,
      status:"PENDING",
      summary:preview.summary,
      payload:draft.payload
    });
  }

  cancel(changeId:string,now:string,reason:string):EffectiveConfigurationChange{return this.changes.transition(changeId,"CANCELLED",now,reason);}

  applyDue(businessDate:string,now:string):EffectiveChangeApplyReport{
    const date=validDate(businessDate),timestamp=new Date(now).toISOString();
    const due=this.changes.list("PENDING").filter(change=>change.effectiveBusinessDate<=date);
    let applied=0,needsReview=0;const changeIds:string[]=[];
    for(const change of due){
      changeIds.push(change.changeId);
      const current=this.config.load();
      if(current.revision!==change.baseRevision){
        this.changes.transition(change.changeId,"NEEDS_REVIEW",timestamp,`configuration revision drifted from ${change.baseRevision} to ${current.revision}; automatic rebase is forbidden`);
        needsReview+=1;continue;
      }
      try{
        if(change.kind==="PROGRAM")new PublishingProgramManagementService(this.config,this.accounts).apply(change.payload as PublishingProgramDraft,change.baseRevision,timestamp);
        else if(change.kind==="RHYTHM"){
          const payload=change.payload as {id:string;policy:SchedulingPolicy};
          new RhythmCalendarManagementService(this.config).saveSchedulePolicy(payload.id,payload.policy,change.baseRevision,timestamp);
        }else new RhythmCalendarManagementService(this.config).saveOperatingCalendar(change.payload as OperatingCalendar,change.baseRevision,timestamp);
        this.changes.transition(change.changeId,"APPLIED",timestamp,"effective date reached; exact preview base revision still current");
        applied+=1;
      }catch(error){
        this.changes.transition(change.changeId,"NEEDS_REVIEW",timestamp,`apply failed: ${error instanceof Error?error.message:String(error)}`);
        needsReview+=1;
      }
    }
    return{inspected:due.length,applied,needsReview,changeIds};
  }
}
