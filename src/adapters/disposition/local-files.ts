import { randomBytes } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import type { SourceObservationLookupPort } from "../../domain/ingress-ports.js";
import type { SourceDispositionPort } from "../../domain/ports.js";

export class LocalSourceDispositionError extends Error {}

function inside(root:string,candidate:string):string{
  const resolvedRoot=resolve(root),absolute=resolve(candidate);
  if(absolute!==resolvedRoot&&!absolute.startsWith(resolvedRoot+sep))throw new LocalSourceDispositionError(`Local disposition path escapes source root: ${candidate}`);
  return absolute;
}
function sourcePath(lookup:SourceObservationLookupPort,root:string,observationId:string):string{
  const record=lookup.getSourceObservation(observationId);if(!record)throw new LocalSourceDispositionError(`Unknown source observation: ${observationId}`);
  const path=record.observation.metadata.localPath;if(!path)throw new LocalSourceDispositionError(`Source observation ${observationId} has no localPath metadata`);
  return inside(root,path);
}
function stableJson(value:unknown):string{return JSON.stringify(value,null,2)+"\n";}

/** Writes exactly one deterministic status sidecar adjacent to the source file. Existing conflicting sidecars are never overwritten. */
export class LocalSidecarDispositionAdapter implements SourceDispositionPort {
  constructor(private readonly lookup:SourceObservationLookupPort,private readonly sourceRoot:string){}
  async markCompleted(sourceObservationId:string,publicationIds:readonly string[]):Promise<void>{this.write(sourceObservationId,{schemaVersion:1,status:"completed",sourceObservationId,publicationIds:[...publicationIds].sort()});}
  async markBlocked(sourceObservationId:string,reason:string):Promise<void>{this.write(sourceObservationId,{schemaVersion:1,status:"blocked",sourceObservationId,publicationIds:[],reason});}
  private write(sourceObservationId:string,payload:unknown):void{
    const source=sourcePath(this.lookup,this.sourceRoot,sourceObservationId),sidecar=`${source}.flerdvision.json`,content=stableJson(payload);
    if(existsSync(sidecar)){
      const existing=readFileSync(sidecar,"utf8");if(existing===content)return;
      throw new LocalSourceDispositionError(`Conflicting sidecar already exists: ${sidecar}`);
    }
    const temp=`${sidecar}.tmp-${randomBytes(6).toString("hex")}`;
    try{writeFileSync(temp,content,{encoding:"utf8",mode:0o600});if(existsSync(sidecar))throw new LocalSourceDispositionError(`Sidecar appeared concurrently: ${sidecar}`);renameSync(temp,sidecar);}finally{rmSync(temp,{force:true});}
  }
}

/** Moves a completed local source file to an explicit destination inside the configured source root. */
export class LocalMoveDispositionAdapter implements SourceDispositionPort {
  private readonly destination:string;
  constructor(private readonly lookup:SourceObservationLookupPort,private readonly sourceRoot:string,destinationRef:string){
    if(!destinationRef.trim())throw new LocalSourceDispositionError("Local move disposition requires completedDestinationRef");
    this.destination=inside(sourceRoot,resolve(sourceRoot,destinationRef));
    if(!existsSync(this.destination)||!statSync(this.destination).isDirectory())throw new LocalSourceDispositionError(`Local completed destination must already exist and be a directory: ${this.destination}`);
  }
  async markCompleted(sourceObservationId:string,_publicationIds:readonly string[]):Promise<void>{
    const source=sourcePath(this.lookup,this.sourceRoot,sourceObservationId),target=inside(this.sourceRoot,join(this.destination,basename(source)));
    if(source===target)return;
    const sourceExists=existsSync(source),targetExists=existsSync(target);
    if(!sourceExists&&targetExists&&statSync(target).isFile())return;
    if(!sourceExists)throw new LocalSourceDispositionError(`Source file is missing and target is not present: ${source}`);
    if(targetExists)throw new LocalSourceDispositionError(`Move target already exists; refusing overwrite: ${target}`);
    renameSync(source,target);
  }
  async markBlocked(_sourceObservationId:string,_reason:string):Promise<void>{throw new LocalSourceDispositionError("Local move disposition is completion-only; blocked source files are never moved automatically");}
}
