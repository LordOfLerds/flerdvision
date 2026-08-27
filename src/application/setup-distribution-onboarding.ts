import { createHash } from "node:crypto";
import type { DistributionConfigurationStorePort, StoredDistributionConfiguration } from "../domain/distribution-ports.js";
import type { ActivationMode, SourceActivationCursor, SourceConnection, SourceConnectionKind, SourceLane } from "../domain/distribution.js";
import { assertConfigurationReferentialIntegrity } from "./distribution-config.js";

function stable(prefix:string,value:string):string{return `${prefix}:${createHash("sha256").update(value).digest("hex").slice(0,24)}`;}
function laneLabel(folderPath:string):string{
  const parts=folderPath.split(" / ").map(value=>value.trim()).filter(Boolean);
  return parts.at(-1)??folderPath.trim()||"Source Lane";
}

export interface SetupSourceProvider {
  kind:SourceConnectionKind;
  /** Deployment/provider root. Local = absolute allowed root; Drive = provider root alias. */
  rootRef:string;
  displayName:string;
}

export interface SetupDistributionLaneParams {
  provider:SetupSourceProvider;
  folderRef:string;
  folderPath:string;
  interpretSubstructure:boolean;
  activationMode:Extract<ActivationMode,"NEW_ONLY"|"IMPORT_BACKLOG">;
  now:string;
}

export interface SetupDistributionLaneResult {
  created:boolean;
  stored:StoredDistributionConfiguration;
  source:SourceConnection;
  lane:SourceLane;
  cursor:SourceActivationCursor;
}

export function sourceConnectionIdFor(provider:SetupSourceProvider):string{
  if(!provider.rootRef.trim())throw new Error("Source provider rootRef is required");
  return stable("source",`${provider.kind}|${provider.rootRef}`);
}

export function sourceLaneIdFor(connectionId:string,folderRef:string):string{
  if(!folderRef.trim())throw new Error("Source folderRef is required");
  return stable("lane",`${connectionId}|${folderRef}`);
}

/**
 * Onboarding stops at SourceConnection + SourceLane. It does not bind any social account. The
 * account/lane relationship is created later through PublishingProgram/DistributionRoute.
 */
export class SetupDistributionOnboardingService {
  constructor(private readonly store:DistributionConfigurationStorePort){}

  registerLane(params:SetupDistributionLaneParams):SetupDistributionLaneResult{
    const timestamp=new Date(params.now).toISOString();
    if(!params.folderPath.trim())throw new Error("Source folderPath display label is required");
    const current=this.store.load();
    const connectionId=sourceConnectionIdFor(params.provider);
    const laneId=sourceLaneIdFor(connectionId,params.folderRef);
    const existingLane=current.config.lanes.find(item=>item.laneId===laneId);
    const existingCursor=current.config.activationCursors.find(item=>item.laneId===laneId);
    const existingSource=current.config.sources.find(item=>item.connectionId===connectionId);

    if(existingLane&&existingCursor&&existingSource){
      if(existingLane.folderRef!==params.folderRef||existingLane.connectionId!==connectionId)throw new Error(`Existing lane ${laneId} has incompatible source identity`);
      if(existingSource.kind!==params.provider.kind||existingSource.rootRef!==params.provider.rootRef)throw new Error(`Existing source ${connectionId} has incompatible provider identity`);
      return{created:false,stored:current,source:existingSource,lane:existingLane,cursor:existingCursor};
    }

    const source:SourceConnection=existingSource??{
      connectionId,
      displayName:params.provider.displayName.trim()||"Source",
      kind:params.provider.kind,
      rootRef:params.provider.rootRef,
      enabled:true,
      disposition:{mode:"database_only",leavePartialUntouched:true,leaveBlockedUntouched:true}
    };
    const displayName=laneLabel(params.folderPath);
    const creatorId=stable("creator",laneId);
    const lane:SourceLane=existingLane??{
      laneId,
      connectionId,
      displayName,
      creatorId,
      folderRef:params.folderRef,
      folderPath:params.folderPath,
      interpretation:params.interpretSubstructure
        ?{kind:"creator_week_day",creatorAlias:displayName}
        :{kind:"flat"},
      enabled:true
    };
    const cursor:SourceActivationCursor=existingCursor??{
      laneId,
      mode:params.activationMode,
      activatedAt:timestamp
    };

    const sources=existingSource?current.config.sources:[...current.config.sources,source];
    const lanes=existingLane?current.config.lanes:[...current.config.lanes,lane];
    const activationCursors=existingCursor?current.config.activationCursors:[...current.config.activationCursors,cursor];
    const nextConfig={...current.config,sources,lanes,activationCursors};
    assertConfigurationReferentialIntegrity(nextConfig);
    const stored=this.store.save({
      updatedAt:timestamp,
      config:nextConfig,
      schedulePolicies:current.schedulePolicies,
      operatingCalendars:current.operatingCalendars,
      planningPolicy:current.planningPolicy,
      ...(current.runtimePolicy?{runtimePolicy:current.runtimePolicy}:{})
    },current.revision);
    return{created:true,stored,source,lane,cursor};
  }
}
