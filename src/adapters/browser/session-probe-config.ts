import { readFileSync } from "node:fs";
import type { Platform } from "../../domain/model.js";
import type { ConfiguredDomSessionProbeConfig } from "./configured-dom-probe.js";

export type SessionProbeCalibrationStatus="UNVERIFIED"|"CALIBRATED";

export interface SessionProbeConfigEntry {
  probeId:string;
  platform:Platform;
  accountId?:string;
  calibrationStatus:SessionProbeCalibrationStatus;
  calibratedAt?:string;
  calibratedBy?:string;
  config:ConfiguredDomSessionProbeConfig;
}

export interface SessionProbeConfigFile {schemaVersion:1;probes:readonly SessionProbeConfigEntry[];}
export class SessionProbeConfigError extends Error {}

function optionalStrings(value:unknown,path:string):readonly string[]|undefined{
  if(value===undefined)return undefined;
  if(!Array.isArray(value)||value.some(item=>typeof item!=="string"||!item.trim()))throw new SessionProbeConfigError(`${path} must be an array of non-empty strings`);
  return value.map(item=>(item as string).trim());
}
function optionalString(value:unknown,path:string):string|undefined{
  if(value===undefined)return undefined;
  if(typeof value!=="string"||!value.trim())throw new SessionProbeConfigError(`${path} must be a non-empty string`);
  return value.trim();
}
function hasPlaceholder(value:unknown):boolean{return typeof value==="string"&&value.includes("__CALIBRATE__");}

function configFromUnknown(value:unknown,path:string,calibrated:boolean):ConfiguredDomSessionProbeConfig{
  if(!value||typeof value!=="object")throw new SessionProbeConfigError(`${path} must be an object`);
  const item=value as Record<string,unknown>;
  if(typeof item.probeUrl!=="string"||!/^https:\/\//.test(item.probeUrl))throw new SessionProbeConfigError(`${path}.probeUrl must be https`);
  if(typeof item.identitySelector!=="string"||!item.identitySelector.trim())throw new SessionProbeConfigError(`${path}.identitySelector is required`);
  const identityAttribute=optionalString(item.identityAttribute,`${path}.identityAttribute`);
  const authUrlIncludes=optionalStrings(item.authUrlIncludes,`${path}.authUrlIncludes`);
  const challengeUrlIncludes=optionalStrings(item.challengeUrlIncludes,`${path}.challengeUrlIncludes`);
  const authSelector=optionalString(item.authSelector,`${path}.authSelector`);
  const challengeSelector=optionalString(item.challengeSelector,`${path}.challengeSelector`);
  const settleMs=item.settleMs===undefined?undefined:Number(item.settleMs);
  if(settleMs!==undefined&&(!Number.isInteger(settleMs)||settleMs<0||settleMs>30000))throw new SessionProbeConfigError(`${path}.settleMs must be an integer from 0 to 30000`);
  if(item.navigate!==undefined&&typeof item.navigate!=="boolean")throw new SessionProbeConfigError(`${path}.navigate must be boolean`);
  const navigate=item.navigate as boolean|undefined;
  if(calibrated){
    const values=[item.probeUrl,item.identitySelector,identityAttribute,authSelector,challengeSelector,...(authUrlIncludes??[]),...(challengeUrlIncludes??[])];
    if(values.some(hasPlaceholder))throw new SessionProbeConfigError(`${path} still contains calibration placeholder`);
  }
  return{
    probeUrl:item.probeUrl,
    identitySelector:item.identitySelector.trim(),
    ...(identityAttribute?{identityAttribute}:{}),
    ...(authUrlIncludes?{authUrlIncludes}:{}),
    ...(challengeUrlIncludes?{challengeUrlIncludes}:{}),
    ...(authSelector?{authSelector}:{}),
    ...(challengeSelector?{challengeSelector}:{}),
    ...(settleMs!==undefined?{settleMs}:{}),
    ...(navigate!==undefined?{navigate}:{}),
  };
}

export function parseSessionProbeConfigFile(raw:unknown,requireCalibrated=false):SessionProbeConfigFile{
  if(!raw||typeof raw!=="object")throw new SessionProbeConfigError("Session probe config must be an object");
  const item=raw as Record<string,unknown>;
  if(item.schemaVersion!==1)throw new SessionProbeConfigError("Unsupported session probe schemaVersion");
  if(!Array.isArray(item.probes))throw new SessionProbeConfigError("Session probe config probes must be an array");
  const ids=new Set<string>();
  const probes=item.probes.map((rawEntry,index):SessionProbeConfigEntry=>{
    if(!rawEntry||typeof rawEntry!=="object")throw new SessionProbeConfigError(`probes[${index}] must be an object`);
    const entry=rawEntry as Record<string,unknown>;
    if(typeof entry.probeId!=="string"||!entry.probeId.trim())throw new SessionProbeConfigError(`probes[${index}].probeId is required`);
    if(ids.has(entry.probeId))throw new SessionProbeConfigError(`Duplicate probeId: ${entry.probeId}`);ids.add(entry.probeId);
    if(entry.platform!=="instagram"&&entry.platform!=="tiktok"&&entry.platform!=="youtube")throw new SessionProbeConfigError(`probes[${index}].platform is invalid`);
    if(entry.accountId!==undefined&&(typeof entry.accountId!=="string"||!entry.accountId.trim()))throw new SessionProbeConfigError(`probes[${index}].accountId must be non-empty when provided`);
    if(entry.calibrationStatus!=="UNVERIFIED"&&entry.calibrationStatus!=="CALIBRATED")throw new SessionProbeConfigError(`probes[${index}].calibrationStatus is invalid`);
    const calibrated=entry.calibrationStatus==="CALIBRATED";
    if(requireCalibrated&&!calibrated)throw new SessionProbeConfigError(`Probe ${entry.probeId} is not calibrated`);
    if(calibrated&&(typeof entry.calibratedAt!=="string"||typeof entry.calibratedBy!=="string"))throw new SessionProbeConfigError(`Calibrated probe ${entry.probeId} requires calibratedAt and calibratedBy`);
    return{
      probeId:entry.probeId.trim(),platform:entry.platform,
      ...(typeof entry.accountId==="string"?{accountId:entry.accountId.trim()}:{}),
      calibrationStatus:entry.calibrationStatus,
      ...(typeof entry.calibratedAt==="string"?{calibratedAt:entry.calibratedAt}:{}),
      ...(typeof entry.calibratedBy==="string"?{calibratedBy:entry.calibratedBy}:{}),
      config:configFromUnknown(entry.config,`probes[${index}].config`,calibrated)
    };
  });
  return{schemaVersion:1,probes};
}

export function loadSessionProbeConfigFile(path:string):SessionProbeConfigFile{
  return parseSessionProbeConfigFile(JSON.parse(readFileSync(path,"utf8")) as unknown,false);
}

export function calibratedSessionProbeFor(file:SessionProbeConfigFile,accountId:string,platform:Platform):SessionProbeConfigEntry|null{
  const exact=file.probes.filter(item=>item.calibrationStatus==="CALIBRATED"&&item.platform===platform&&item.accountId===accountId);
  if(exact.length>1)throw new SessionProbeConfigError(`Multiple calibrated session probes match account ${accountId}`);
  if(exact.length===1)return exact[0]!;
  const generic=file.probes.filter(item=>item.calibrationStatus==="CALIBRATED"&&item.platform===platform&&!item.accountId);
  if(generic.length>1)throw new SessionProbeConfigError(`Multiple calibrated generic session probes match ${platform}`);
  return generic[0]??null;
}
