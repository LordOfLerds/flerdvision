import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JsonWorkspaceRegistry } from "../dist/adapters/workspace/json-registry.js";
import { ReleaseQualificationService } from "../dist/application/release-qualification.js";
import { ReleaseQualificationReceiptService } from "../dist/application/release-qualification-receipt.js";
import { requiredQualificationGates } from "../dist/domain/workspace.js";

function registry(root,name){return new JsonWorkspaceRegistry(join(root,name,"registry.json"));}

function passStage(registry,stage,releaseSha,workspaceId,runId){
  const q=new ReleaseQualificationService(registry);
  const run=q.start({runId,releaseSha,stage,workspaceId,hostFingerprint:`${stage}-host`,now:"2026-08-27T08:00:00.000Z",operatorId:"tester"});
  for(const gate of requiredQualificationGates(stage))q.recordGate({runId:run.runId,gate,passed:true,now:"2026-08-27T08:01:00.000Z",operatorId:"tester",summary:`${gate} passed`,artifactRefs:[`evidence://${stage}/${gate}`]});
  return q.finalize(run.runId);
}

test("passed Luca receipt imports into an independent Fabian registry and unlocks predecessor gate",()=>{
  const root=mkdtempSync(join(tmpdir(),"flerdvision-receipt-"));
  try{
    const releaseSha="release-exact-sha",lucaRegistry=registry(root,"luca"),fabianRegistry=registry(root,"fabian");
    passStage(lucaRegistry,"LUCA_MAC",releaseSha,"luca","run:luca");
    const receipt=new ReleaseQualificationReceiptService(lucaRegistry).export("run:luca","2026-08-27T09:00:00.000Z");
    const receiver=new ReleaseQualificationReceiptService(fabianRegistry);
    assert.equal(receiver.verify(receipt,{releaseSha,stage:"LUCA_MAC"}).valid,true);
    const imported=receiver.import(receipt,{releaseSha,stage:"LUCA_MAC"});
    assert.equal(imported.status,"PASSED");
    assert.doesNotThrow(()=>new ReleaseQualificationService(fabianRegistry).start({runId:"run:fabian",releaseSha,stage:"FABIAN_MAC",workspaceId:"fabian",hostFingerprint:"fabian-host",now:"2026-08-27T09:01:00.000Z",operatorId:"tester"}));
  }finally{rmSync(root,{recursive:true,force:true});}
});

test("receipt verification rejects payload tampering, wrong release and missing gate evidence",()=>{
  const root=mkdtempSync(join(tmpdir(),"flerdvision-receipt-"));
  try{
    const reg=registry(root,"source"),releaseSha="sha-1";passStage(reg,"LUCA_MAC",releaseSha,"luca","run:luca");
    const service=new ReleaseQualificationReceiptService(reg),receipt=service.export("run:luca","2026-08-27T09:00:00.000Z");
    assert.equal(service.verify(receipt,{releaseSha:"sha-other",stage:"LUCA_MAC"}).valid,false);
    const tampered={...receipt,run:{...receipt.run,releaseSha:"tampered"}};
    assert.ok(service.verify(tampered).reasons.includes("payload_hash_mismatch"));
    const gateIndex=receipt.gates.findIndex(g=>g.passed&&g.artifactRefs.length>0);assert.ok(gateIndex>=0);
    const gates=receipt.gates.map((gate,index)=>index===gateIndex?{...gate,artifactRefs:[]}:gate);
    const missingEvidence={...receipt,gates};
    const verification=service.verify(missingEvidence);
    assert.equal(verification.valid,false);
    assert.ok(verification.reasons.some(reason=>reason.startsWith("gate_missing_artifact:"))||verification.reasons.includes("payload_hash_mismatch"));
  }finally{rmSync(root,{recursive:true,force:true});}
});
