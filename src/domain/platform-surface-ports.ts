import type { Platform, PublicationFormat } from "./model.js";
import type { PlatformSurfaceContract, SurfaceReplayEvidence, SurfaceStepObservation } from "./platform-surface.js";

export interface StoredSurfaceContractVersion { versionId:string; contract:PlatformSurfaceContract; recordedAt:string; }
export interface PlatformSurfaceStorePort {
  recordObservation(observation:SurfaceStepObservation):SurfaceStepObservation;
  listObservations(accountId:string,platform?:Platform,format?:PublicationFormat):readonly SurfaceStepObservation[];
  recordContract(contract:PlatformSurfaceContract,now:string):StoredSurfaceContractVersion;
  latestContract(accountId:string,postingProfileId:string):StoredSurfaceContractVersion|null;
  recordReplay(evidence:SurfaceReplayEvidence):SurfaceReplayEvidence;
  listReplays(contractId:string):readonly SurfaceReplayEvidence[];
}
