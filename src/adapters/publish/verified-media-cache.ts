import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import type { ContentItem } from "../../domain/model.js";
import type { LocalMediaArtifact } from "../../domain/platform-ui.js";
import type { MediaMaterializerPort } from "../../domain/platform-ui-ports.js";
import type { VerifiedMediaCachePort, VerifiedMediaCacheRecord } from "../../domain/verified-media-cache.js";

function cacheKey(contentId:string,fingerprint:string):string{return createHash("sha256").update(`${contentId}\n${fingerprint}`).digest("hex");}
async function sha256File(path:string):Promise<string>{return await new Promise((resolveHash,reject)=>{const hash=createHash("sha256"),stream=createReadStream(path);stream.on("data",chunk=>hash.update(chunk));stream.on("error",reject);stream.on("end",()=>resolveHash(hash.digest("hex")));});}
function inside(root:string,path:string):string{const r=resolve(root),p=resolve(path);if(p!==r&&!p.startsWith(r+sep))throw new Error(`Verified cache path escapes root: ${path}`);return p;}
function safeExtension(path:string):string{const ext=extname(basename(path)).toLowerCase();return /^[.][a-z0-9]{1,8}$/.test(ext)?ext:".bin";}

/**
 * Copies the first successfully materialized artifact into a content+fingerprint cache. Subsequent
 * Instagram/TikTok/YT preparations receive the same verified bytes. release() never evicts; source
 * media is never modified or deleted by this adapter.
 */
export class VerifiedMediaCacheMaterializer implements MediaMaterializerPort, VerifiedMediaCachePort {
  private readonly root:string;
  constructor(private readonly inner:MediaMaterializerPort,root:string,private readonly clock:()=>string=()=>new Date().toISOString()){
    this.root=resolve(root);
  }
  private directory(contentId:string,fingerprint:string):string{return inside(this.root,join(this.root,cacheKey(contentId,fingerprint)));}
  private manifestPath(contentId:string,fingerprint:string):string{return join(this.directory(contentId,fingerprint),"manifest.json");}

  async get(contentId:string,mediaFingerprint:string):Promise<VerifiedMediaCacheRecord|null>{
    try{
      const manifest=JSON.parse(await readFile(this.manifestPath(contentId,mediaFingerprint),"utf8")) as VerifiedMediaCacheRecord;
      if(manifest.contentId!==contentId||manifest.mediaFingerprint!==mediaFingerprint||manifest.cacheKey!==cacheKey(contentId,mediaFingerprint))return null;
      inside(this.root,manifest.localPath);
      const info=await stat(manifest.localPath);
      if(!info.isFile()||info.size!==manifest.sizeBytes)return null;
      const digest=await sha256File(manifest.localPath);
      if(digest!==manifest.sha256)return null;
      return manifest;
    }catch{return null;}
  }

  async materialize(content:ContentItem):Promise<LocalMediaArtifact>{
    const existing=await this.get(content.contentId,content.mediaFingerprint);
    if(existing&&existing.sourceRef!==content.immutableMediaRef){
      await this.evict(content.contentId,content.mediaFingerprint);
    }else if(existing){
      const touched:{[K in keyof VerifiedMediaCacheRecord]:VerifiedMediaCacheRecord[K]}={...existing,lastAccessedAt:new Date(this.clock()).toISOString()};
      await writeFile(this.manifestPath(content.contentId,content.mediaFingerprint),`${JSON.stringify(touched,null,2)}\n`,{encoding:"utf8",mode:0o600});
      return{contentId:touched.contentId,sourceRef:touched.sourceRef,localPath:touched.localPath,sha256:touched.sha256,sizeBytes:touched.sizeBytes};
    }

    const directory=this.directory(content.contentId,content.mediaFingerprint);
    await mkdir(directory,{recursive:true,mode:0o700});
    // Remove only this cache directory after a corrupt/stale cache miss; never touch source paths.
    await rm(directory,{recursive:true,force:true});
    await mkdir(directory,{recursive:true,mode:0o700});
    const artifact=await this.inner.materialize(content);
    try{
      if(artifact.contentId!==content.contentId)throw new Error("Materializer returned content for a different contentId");
      if(artifact.sourceRef!==content.immutableMediaRef)throw new Error("Materializer returned media for a different immutable source ref");
      if(!/^[a-f0-9]{64}$/i.test(artifact.sha256)||artifact.sizeBytes<=0)throw new Error("Materialized media lacks valid immutable SHA/size evidence");
      const extension=safeExtension(artifact.localPath),finalPath=inside(this.root,join(directory,`media${extension}`)),tempPath=inside(this.root,`${finalPath}.partial`);
      await pipeline(createReadStream(artifact.localPath),createWriteStream(tempPath,{mode:0o600}));
      const copied=await stat(tempPath),digest=await sha256File(tempPath);
      if(copied.size!==artifact.sizeBytes||digest.toLowerCase()!==artifact.sha256.toLowerCase()){
        await rm(tempPath,{force:true});
        throw new Error("Verified media cache copy does not match materialized SHA/size");
      }
      await rename(tempPath,finalPath);
      const now=new Date(this.clock()).toISOString();
      const record:VerifiedMediaCacheRecord={cacheKey:cacheKey(content.contentId,content.mediaFingerprint),contentId:content.contentId,mediaFingerprint:content.mediaFingerprint,sourceRef:content.immutableMediaRef,localPath:finalPath,sha256:digest,sizeBytes:copied.size,verifiedAt:now,lastAccessedAt:now};
      await writeFile(this.manifestPath(content.contentId,content.mediaFingerprint),`${JSON.stringify(record,null,2)}\n`,{encoding:"utf8",mode:0o600});
      return{contentId:record.contentId,sourceRef:record.sourceRef,localPath:record.localPath,sha256:record.sha256,sizeBytes:record.sizeBytes};
    }finally{
      // Underlying Drive temp or other provider cache may be released. Local source materializers
      // either no-op or have no release(), so original user media is never deleted here.
      await this.inner.release?.(artifact).catch(()=>{});
    }
  }

  async release(_artifact:LocalMediaArtifact):Promise<void>{/* retained until explicit maintenance */}

  async evict(contentId:string,mediaFingerprint:string):Promise<boolean>{
    const directory=this.directory(contentId,mediaFingerprint);
    const record=await this.get(contentId,mediaFingerprint);
    await rm(directory,{recursive:true,force:true});
    return record!==null;
  }
}
