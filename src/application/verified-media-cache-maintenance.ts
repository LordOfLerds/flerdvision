import type { ContentAsset } from "../domain/distribution.js";
import type { VerifiedMediaCacheMaintenancePort, VerifiedMediaCacheMaintenanceReport, VerifiedMediaCachePort } from "../domain/verified-media-cache.js";

export class VerifiedMediaCacheMaintenance implements VerifiedMediaCacheMaintenancePort {
  constructor(private readonly cache:VerifiedMediaCachePort){}

  async evictEligible(assets:readonly ContentAsset[],now:string,retentionHours:number):Promise<VerifiedMediaCacheMaintenanceReport>{
    if(!Number.isFinite(retentionHours)||retentionHours<0)throw new Error("Verified media cache retentionHours must be >= 0");
    const nowMs=new Date(now).getTime();if(!Number.isFinite(nowMs))throw new Error(`Invalid maintenance time: ${now}`);
    let inspected=0,evicted=0,retained=0;const errors:string[]=[];
    for(const asset of assets){
      inspected+=1;
      if(asset.state!=="COMPLETE"){retained+=1;continue;}
      const completedAt=asset.metadata.completedAt;
      if(!completedAt){retained+=1;errors.push(`${asset.assetId}: COMPLETE asset has no completedAt evidence`);continue;}
      const completedMs=new Date(completedAt).getTime();
      if(!Number.isFinite(completedMs)){retained+=1;errors.push(`${asset.assetId}: invalid completedAt`);continue;}
      if(nowMs-completedMs<retentionHours*3_600_000){retained+=1;continue;}
      try{
        if(await this.cache.evict(asset.contentId,asset.mediaFingerprint))evicted+=1;
        else retained+=1;
      }catch(error){retained+=1;errors.push(`${asset.assetId}: ${error instanceof Error?error.message:String(error)}`);}
    }
    return{inspected,evicted,retained,errors};
  }
}
