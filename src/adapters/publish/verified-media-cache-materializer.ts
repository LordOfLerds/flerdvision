import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readSync, rmSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { ContentItem } from "../../domain/model.js";
import type { LocalMediaArtifact } from "../../domain/platform-ui.js";
import type { MediaMaterializerPort } from "../../domain/platform-ui-ports.js";
import type { VerifiedMediaCachePort, VerifiedMediaCacheStorePort } from "../../domain/verified-media-cache-ports.js";

function sha256File(path:string):string{
  const hash=createHash("sha256"),fd=openSync(path,"r"),buffer=new Uint8Array(1024*1024);
  try{while(true){const count=readSync(fd,buffer,0,buffer.length,null);if(count<=0)break;hash.update(buffer.subarray(0,count));}}
  finally{closeSync(fd);}
  return hash.digest("hex");
}
function within(path:string,root:string):boolean{
  const absolute=resolve(path),base=resolve(root);
  return absolute===base||absolute.startsWith(base+sep);
}

/**
 * Keeps Drive media after readiness so the same immutable source bytes can feed several routes
 * without a second download. Cache evidence never replaces ContentItem.mediaFingerprint.
 */
export class VerifiedMediaCacheMaterializer implements VerifiedMediaCachePort, MediaMaterializerPort {
  private readonly cacheRoot:string;
  constructor(
    private readonly inner:MediaMaterializerPort,
    private readonly store:VerifiedMediaCacheStorePort,
    cacheRoot:string,
    private readonly clock:()=>string=()=>new Date().toISOString()
  ){
    this.cacheRoot=resolve(cacheRoot);
  }

  private discard(contentId:string,mediaFingerprint:string,localPath:string,managed:boolean):void{
    if(managed&&within(localPath,this.cacheRoot))rmSync(localPath,{force:true});
    this.store.remove(contentId,mediaFingerprint);
  }

  async materialize(content:ContentItem):Promise<LocalMediaArtifact>{
    const cached=this.store.get(content.contentId,content.mediaFingerprint);
    if(cached){
      const sameSource=cached.sourceRef===content.immutableMediaRef;
      const exists=existsSync(cached.localPath);
      if(sameSource&&exists){
        const stats=statSync(cached.localPath);
        if(stats.isFile()&&stats.size===cached.sizeBytes){
          const digest=sha256File(cached.localPath);
          if(digest===cached.sha256){
            this.store.touch(content.contentId,content.mediaFingerprint,this.clock());
            return{contentId:content.contentId,sourceRef:cached.sourceRef,localPath:cached.localPath,sha256:cached.sha256,sizeBytes:cached.sizeBytes};
          }
        }
      }
      this.discard(content.contentId,content.mediaFingerprint,cached.localPath,cached.managed);
    }

    const artifact=await this.inner.materialize(content);
    if(artifact.contentId!==content.contentId)throw new Error(`Materializer returned wrong content id for ${content.contentId}`);
    if(artifact.sourceRef!==content.immutableMediaRef)throw new Error(`Materializer returned wrong source ref for ${content.contentId}`);
    if(artifact.sizeBytes<=0)throw new Error(`Materialized media is empty for ${content.contentId}`);
    const now=this.clock();
    const managed=content.immutableMediaRef.startsWith("gdrive://file/")&&within(artifact.localPath,this.cacheRoot);
    this.store.put({
      contentId:content.contentId,
      mediaFingerprint:content.mediaFingerprint,
      sourceRef:content.immutableMediaRef,
      localPath:artifact.localPath,
      sha256:artifact.sha256,
      sizeBytes:artifact.sizeBytes,
      managed,
      verifiedAt:now,
      lastAccessedAt:now
    });
    return artifact;
  }

  /** Intentionally retain verified managed artifacts across readiness and cross-post preparation. */
  async release(_artifact:LocalMediaArtifact):Promise<void>{}

  async evict(contentId:string,mediaFingerprint:string):Promise<boolean>{
    const entry=this.store.get(contentId,mediaFingerprint);
    if(!entry)return false;
    this.discard(contentId,mediaFingerprint,entry.localPath,entry.managed);
    return true;
  }

  async sweep(olderThan:string):Promise<{removed:number;retained:number}>{
    const cutoff=new Date(olderThan).getTime();
    if(!Number.isFinite(cutoff))throw new Error(`Invalid cache cutoff: ${olderThan}`);
    let removed=0,retained=0;
    for(const entry of this.store.list()){
      if(new Date(entry.lastAccessedAt).getTime()<cutoff){await this.evict(entry.contentId,entry.mediaFingerprint);removed+=1;}
      else retained+=1;
    }
    return{removed,retained};
  }
}
