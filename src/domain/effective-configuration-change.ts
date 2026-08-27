export type EffectiveConfigurationChangeKind = "PROGRAM" | "RHYTHM" | "CALENDAR";
export type EffectiveConfigurationChangeStatus = "PENDING" | "APPLIED" | "NEEDS_REVIEW" | "CANCELLED";

export interface EffectiveConfigurationChange {
  changeId:string;
  kind:EffectiveConfigurationChangeKind;
  effectiveBusinessDate:string;
  baseRevision:number;
  createdAt:string;
  createdBy:string;
  status:EffectiveConfigurationChangeStatus;
  summary:string;
  payload:unknown;
  appliedAt?:string;
  reason?:string;
}

export interface EffectiveConfigurationChangeStorePort {
  create(change:EffectiveConfigurationChange):EffectiveConfigurationChange;
  get(changeId:string):EffectiveConfigurationChange|null;
  list(status?:EffectiveConfigurationChangeStatus):readonly EffectiveConfigurationChange[];
  transition(changeId:string,to:Exclude<EffectiveConfigurationChangeStatus,"PENDING">,at:string,reason?:string):EffectiveConfigurationChange;
}

export interface EffectiveConfigurationChangeCommandPort {
  schedule(kind:EffectiveConfigurationChangeKind,payload:unknown,effectiveBusinessDate:string,now:string,createdBy:string):EffectiveConfigurationChange;
  listPending():readonly EffectiveConfigurationChange[];
  cancel(changeId:string,now:string,reason:string):EffectiveConfigurationChange;
}
