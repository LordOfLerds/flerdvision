import { createHash } from "node:crypto";
import type { ReleaseQualificationStorePort } from "../domain/workspace-ports.js";
import { requiredQualificationGates, type DeploymentStage, type QualificationGateResult, type ReleaseQualificationRun } from "../domain/workspace.js";

export interface ReleaseQualificationReceipt {
  schemaVersion:1;
  run:ReleaseQualificationRun;
  gates:readonly QualificationGateResult[];
  issuedAt:string;
  payloadHash:string;
}

export interface ReceiptVerification {
  valid:boolean;
  reasons:readonly string[];
}

function canonical(value:unknown):string{
  if(Array.isArray(value))return`[${value.map(canonical).join(",")}]`;
  if(value&&typeof value==="object")return`{${Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>`${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
function hashPayload(input:Omit<ReleaseQualificationReceipt,"payloadHash">):string{return createHash("sha256").update(canonical(input)).digest("hex");}
function latestGates(results:readonly QualificationGateResult[]):QualificationGateResult[]{
  const map=new Map<string,QualificationGateResult>();
  for(const result of [...results].sort((a,b)=>a.checkedAt.localeCompare(b.checkedAt)||a.gateResultId.localeCompare(b.gateResultId)))map.set(result.gate,result);
  return [...map.values()].sort((a,b)=>a.gate.localeCompare(b.gate));
}

export class ReleaseQualificationReceiptService {
  constructor(private readonly store:ReleaseQualificationStorePort){}

  export(runId:string,issuedAt:string):ReleaseQualificationReceipt{
    const run=this.store.getRun(runId);if(!run)throw new Error(`Unknown qualification run: ${runId}`);
    if(run.status!=="PASSED")throw new Error(`Only PASSED qualification runs may be exported; ${runId} is ${run.status}`);
    const gates=latestGates(this.store.listGates(runId)),required=requiredQualificationGates(run.stage);
    for(const gate of required){
      const result=gates.find(item=>item.gate===gate);
      if(!result?.passed)throw new Error(`Receipt export refused: required gate ${gate} is not PASS`);
      if(result.artifactRefs.length===0)throw new Error(`Receipt export refused: required gate ${gate} has no durable artifactRef`);
    }
    const base={schemaVersion:1 as const,run,gates,issuedAt:new Date(issuedAt).toISOString()};
    return{...base,payloadHash:hashPayload(base)};
  }

  verify(receipt:ReleaseQualificationReceipt,expect?:{releaseSha?:string;stage?:DeploymentStage}):ReceiptVerification{
    const reasons:string[]=[];
    if(receipt.schemaVersion!==1)reasons.push("unsupported_schema_version");
    const {payloadHash,...base}=receipt;
    if(hashPayload(base)!==payloadHash)reasons.push("payload_hash_mismatch");
    if(receipt.run.status!=="PASSED")reasons.push("run_not_passed");
    if(expect?.releaseSha&&receipt.run.releaseSha!==expect.releaseSha)reasons.push("release_sha_mismatch");
    if(expect?.stage&&receipt.run.stage!==expect.stage)reasons.push("stage_mismatch");
    const latest=latestGates(receipt.gates),required=requiredQualificationGates(receipt.run.stage);
    for(const gate of required){
      const result=latest.find(item=>item.gate===gate);
      if(!result)reasons.push(`gate_missing:${gate}`);
      else if(!result.passed)reasons.push(`gate_not_passed:${gate}`);
      else if(result.artifactRefs.length===0)reasons.push(`gate_missing_artifact:${gate}`);
    }
    for(const result of receipt.gates)if(result.runId!==receipt.run.runId)reasons.push(`foreign_gate_run:${result.gateResultId}`);
    return{valid:reasons.length===0,reasons};
  }

  import(receipt:ReleaseQualificationReceipt,expect?:{releaseSha?:string;stage?:DeploymentStage}):ReleaseQualificationRun{
    const verification=this.verify(receipt,expect);if(!verification.valid)throw new Error(`Qualification receipt invalid: ${verification.reasons.join(", ")}`);
    const existing=this.store.getRun(receipt.run.runId);
    if(existing){
      if(canonical(existing)!==canonical(receipt.run))throw new Error(`Qualification receipt run ${receipt.run.runId} conflicts with local run`);
      return existing;
    }
    const active=this.store.createRun({...receipt.run,status:"ACTIVE"});
    for(const gate of receipt.gates)this.store.appendGate(gate);
    return this.store.updateRunStatus(active.runId,"PASSED");
  }
}
