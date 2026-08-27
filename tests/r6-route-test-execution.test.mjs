import test from "node:test";
import assert from "node:assert/strict";
import { RouteTestExecutionService, RouteE2EGateBridge, RouteTestExecutionError } from "../dist/application/route-test-execution.js";

class MemoryStore { records=[]; record(r){this.records.push(r);return r;} list(routeId){return this.records.filter(r=>r.routeId===routeId);} }
class Runner { calls=[]; async run(routeId,key,checkedAt){this.calls.push([routeId,key,checkedAt]);return{passed:true,summary:`${key} ok`,artifactRefs:[]};} }

test("route executor permits calibration prepare-only after source/session/identity and before surface pass", async()=>{
  const store=new MemoryStore(),runner=new Runner(),svc=new RouteTestExecutionService(store,runner); const sha="abc";
  await assert.rejects(()=>svc.run("r","PREPARE_ONLY",sha,"2026-08-27T07:00:00Z"),/requires source/);
  await svc.run("r","SOURCE",sha,"2026-08-27T07:00:01Z");
  await svc.run("r","SESSION",sha,"2026-08-27T07:00:02Z");
  await svc.run("r","IDENTITY",sha,"2026-08-27T07:00:03Z");
  await svc.run("r","PREPARE_ONLY",sha,"2026-08-27T07:00:04Z");
  assert.equal(svc.readiness("r").prepareOnlyPasses,1);
  assert.equal(svc.readiness("r").sourcePassed,true);
  assert.equal(svc.readiness("r").identityPassed,true);
  assert.equal(svc.readiness("r").verificationPassed,false);
  assert.equal(runner.calls.at(-1)[2],"2026-08-27T07:00:04.000Z");
});

test("surface and verification still retain their strict qualification order",async()=>{
  const store=new MemoryStore(),svc=new RouteTestExecutionService(store,new Runner()),sha="sha";
  await svc.run("r","SOURCE",sha,"2026-08-27T08:00:00Z");
  await svc.run("r","SESSION",sha,"2026-08-27T08:00:01Z");
  await svc.run("r","IDENTITY",sha,"2026-08-27T08:00:02Z");
  await assert.rejects(()=>svc.run("r","VERIFICATION",sha,"2026-08-27T08:00:03Z"),/calibrated\/passing surface/);
  await svc.run("r","SURFACE",sha,"2026-08-27T08:00:04Z");
  await svc.run("r","VERIFICATION",sha,"2026-08-27T08:00:05Z");
  assert.equal(svc.readiness("r").verificationPassed,true);
});

test("generic route executor has no secret-live execution path",()=>{
  const svc=new RouteTestExecutionService(new MemoryStore(),new Runner());
  assert.throws(()=>svc.assertSecretLiveUsesPrivateE2E(),RouteTestExecutionError);
});

test("canonical PrivateE2E gates bridge into route qualification evidence",()=>{
  const store=new MemoryStore(),bridge=new RouteE2EGateBridge(store),svc=new RouteTestExecutionService(store,new Runner());
  const base={runId:"run",checkedAt:"2026-08-27T08:00:00.000Z",checkedBy:"operator",status:"PASS",summary:"ok",artifactRefs:[],details:{}};
  bridge.recordGate("r",{...base,gateResultId:"g1",gate:"PRIVATE_PUBLISH"},"sha");
  bridge.recordGate("r",{...base,gateResultId:"g2",gate:"VERIFICATION"},"sha");
  assert.equal(svc.readiness("r").secretLivePassed,true);
  assert.equal(svc.readiness("r").verificationPassed,true);
});

test("cleanup executor requires secret-live evidence from canonical bridge",async()=>{
  const store=new MemoryStore(),svc=new RouteTestExecutionService(store,new Runner());
  await assert.rejects(()=>svc.run("r","CLEANUP","sha","2026-08-27T08:00:00Z"),/only after canonical secret-live/);
});
