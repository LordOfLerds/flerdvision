import type { DeliveryRequirement, SourceConnectionKind } from "./distribution.js";
import type { ChannelSourceBinding } from "./source-binding.js";

export interface LegacyBindingResolvedFolder {
  provider:{kind:SourceConnectionKind;rootRef:string;displayName:string};
  folderRef:string;
}

export interface LegacyBindingMigrationResolverPort {
  resolve(binding:ChannelSourceBinding):Promise<LegacyBindingResolvedFolder>;
}

export interface LegacyRouteMigrationChoice {
  accountId:string;
  postingProfileId:string;
  copyProfileId:string;
  schedulePolicyId:string;
  operatingCalendarId?:string;
  requirement:DeliveryRequirement;
}

export interface LegacyFolderMigrationGroup {
  groupId:string;
  sourceKind:SourceConnectionKind;
  folderPath:string;
  bindingIds:readonly string[];
  accountIds:readonly string[];
  interpretSubstructure:boolean;
  status:"READY_FOR_LANE"|"MANUAL_REVIEW";
  reasons:readonly string[];
}

export interface LegacyBindingMigrationAnalysis {
  bindings:number;
  folderGroups:readonly LegacyFolderMigrationGroup[];
  manualReviewGroups:number;
  note:string;
}
