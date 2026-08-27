import { readFileSync } from "node:fs";
import type { IngressStorePort } from "../../domain/ingress-ports.js";
import type { PublicationIntent } from "../../domain/model.js";
import type { PublicationPayload } from "../../domain/platform-ui.js";
import type { PublicationPayloadResolverPort } from "../../domain/platform-ui-ports.js";

export interface WorkspacePayloadTemplate {
  copyVersionId:string;
  captionTemplate?:string;
  titleTemplate?:string;
  descriptionTemplate?:string;
  hashtags?:readonly string[];
}
export interface WorkspacePayloadConfig {schemaVersion:1;payloads:readonly WorkspacePayloadTemplate[];}
export class WorkspacePayloadConfigError extends Error {}

function template(value:unknown,path:string):string|undefined{
  if(value===undefined)return undefined;
  if(typeof value!=="string")throw new WorkspacePayloadConfigError(`${path} must be a string`);
  return value;
}
function parse(raw:unknown):WorkspacePayloadConfig{
  if(!raw||typeof raw!=="object")throw new WorkspacePayloadConfigError("copy payload config must be an object");
  const item=raw as Record<string,unknown>;if(item.schemaVersion!==1)throw new WorkspacePayloadConfigError("Unsupported copy payload schemaVersion");
  if(!Array.isArray(item.payloads))throw new WorkspacePayloadConfigError("copy payload config payloads must be an array");
  const ids=new Set<string>(),payloads=item.payloads.map((rawEntry,index):WorkspacePayloadTemplate=>{
    if(!rawEntry||typeof rawEntry!=="object")throw new WorkspacePayloadConfigError(`payloads[${index}] must be an object`);const entry=rawEntry as Record<string,unknown>;
    if(typeof entry.copyVersionId!=="string"||!entry.copyVersionId.trim())throw new WorkspacePayloadConfigError(`payloads[${index}].copyVersionId is required`);const copyVersionId=entry.copyVersionId.trim();
    if(ids.has(copyVersionId))throw new WorkspacePayloadConfigError(`Duplicate copyVersionId: ${copyVersionId}`);ids.add(copyVersionId);
    if(entry.hashtags!==undefined&&(!Array.isArray(entry.hashtags)||entry.hashtags.some(tag=>typeof tag!=="string"||!tag.trim())))throw new WorkspacePayloadConfigError(`payloads[${index}].hashtags must be non-empty strings`);
    const captionTemplate=template(entry.captionTemplate,`payloads[${index}].captionTemplate`),titleTemplate=template(entry.titleTemplate,`payloads[${index}].titleTemplate`),descriptionTemplate=template(entry.descriptionTemplate,`payloads[${index}].descriptionTemplate`);
    if(captionTemplate===undefined&&titleTemplate===undefined&&descriptionTemplate===undefined&&entry.hashtags===undefined)throw new WorkspacePayloadConfigError(`payloads[${index}] has no publication payload fields`);
    return{copyVersionId,...(captionTemplate!==undefined?{captionTemplate}:{}),...(titleTemplate!==undefined?{titleTemplate}:{}),...(descriptionTemplate!==undefined?{descriptionTemplate}:{}),...(Array.isArray(entry.hashtags)?{hashtags:entry.hashtags.map(tag=>(tag as string).trim())}:{})};
  });return{schemaVersion:1,payloads};
}
export function loadWorkspacePayloadConfig(path:string):WorkspacePayloadConfig{return parse(JSON.parse(readFileSync(path,"utf8")) as unknown);}

function render(input:string,variables:Readonly<Record<string,string>>,metadata:Readonly<Record<string,string>>):string{
  return input.replace(/\{([a-zA-Z0-9_.-]+)\}/g,(_all,key:string)=>{
    if(key.startsWith("metadata.")){const name=key.slice("metadata.".length),value=metadata[name];if(value===undefined)throw new WorkspacePayloadConfigError(`Unknown payload metadata placeholder: ${key}`);return value;}
    const value=variables[key];if(value===undefined)throw new WorkspacePayloadConfigError(`Unknown payload placeholder: ${key}`);return value;
  });
}

export class WorkspacePublicationPayloadResolver implements PublicationPayloadResolverPort {
  constructor(private readonly path:string,private readonly content:IngressStorePort){}
  async resolve(intent:PublicationIntent):Promise<PublicationPayload>{
    const entry=loadWorkspacePayloadConfig(this.path).payloads.find(item=>item.copyVersionId===intent.copyVersionId);if(!entry)throw new WorkspacePayloadConfigError(`No publication payload configured for copyVersionId ${intent.copyVersionId}`);
    const stored=this.content.getContentItem(intent.contentId);if(!stored)throw new WorkspacePayloadConfigError(`Content ${intent.contentId} not found while resolving publication payload`);if(stored.item.creatorId!==intent.creatorId)throw new WorkspacePayloadConfigError(`Content creator does not match intent ${intent.intentId}`);
    const metadata=stored.item.metadata,variables:Record<string,string>={contentId:intent.contentId,creatorId:intent.creatorId,accountId:intent.accountId,platform:intent.platform,format:intent.format,filename:metadata.fileName??metadata.filename??""};
    const out:PublicationPayload={copyVersionId:intent.copyVersionId};
    if(entry.captionTemplate!==undefined)Object.assign(out,{caption:render(entry.captionTemplate,variables,metadata)});
    if(entry.titleTemplate!==undefined)Object.assign(out,{title:render(entry.titleTemplate,variables,metadata)});
    if(entry.descriptionTemplate!==undefined)Object.assign(out,{description:render(entry.descriptionTemplate,variables,metadata)});
    if(entry.hashtags!==undefined)Object.assign(out,{hashtags:entry.hashtags.map(tag=>render(tag,variables,metadata).replace(/^#/,""))});
    if(intent.platform==="instagram"||intent.platform==="tiktok"){if(out.caption===undefined)throw new WorkspacePayloadConfigError(`${intent.platform} intent ${intent.intentId} requires a configured caption`);}
    if(intent.platform==="youtube"&&out.title===undefined)throw new WorkspacePayloadConfigError(`YouTube intent ${intent.intentId} requires a configured title`);
    return out;
  }
}
