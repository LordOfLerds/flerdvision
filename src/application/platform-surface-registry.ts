import type { PostingProfile } from "../domain/distribution.js";
import type { PlatformSurfaceStorePort, StoredSurfaceContractVersion } from "../domain/platform-surface-ports.js";
import type { SurfaceReplayEvidence, SurfaceStepObservation } from "../domain/platform-surface.js";
import { buildRecordedSurfaceContract, qualifySurfaceContract } from "./platform-surface-contract.js";

export class PlatformSurfaceRegistryService {
  constructor(private readonly store:PlatformSurfaceStorePort){}
  recordObservation(observation:SurfaceStepObservation):SurfaceStepObservation{return this.store.recordObservation(observation);}
  buildRecorded(accountId:string,profile:PostingProfile,now:string):StoredSurfaceContractVersion{const observations=this.store.listObservations(accountId,profile.platform,profile.format);const contract=buildRecordedSurfaceContract({accountId,profile,observations,createdAt:now});return this.store.recordContract(contract,now);}
  recordReplay(evidence:SurfaceReplayEvidence):SurfaceReplayEvidence{return this.store.recordReplay(evidence);}
  qualify(accountId:string,profile:PostingProfile,now:string):StoredSurfaceContractVersion{const latest=this.store.latestContract(accountId,profile.postingProfileId);if(!latest)throw new Error(`No surface contract recorded for ${accountId}/${profile.postingProfileId}`);if(latest.contract.status==="CALIBRATED")return latest;const qualified=qualifySurfaceContract(latest.contract,this.store.listReplays(latest.contract.contractId),now);return this.store.recordContract(qualified,now);}
}
