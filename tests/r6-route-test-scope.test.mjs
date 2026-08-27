import test from "node:test";
import assert from "node:assert/strict";
import { RouteTestExecutionService } from "../dist/application/route-test-execution.js";

class Store{
  records=[];
  record(record){this.records.push(record);return record;}
  list(routeId){return this.records.filter(item=>item.routeId===routeId);}
}
const runner={async run(routeId,testKey){return{passed:true,summary:`${routeId}:${testKey}`,artifactRefs:[]};}};

test("route readiness never inherits PASS from another release",async()=>{
  const store=new Store(),service=new RouteTestExecutionService(store,runner);
  for(const key of ["SOURCE","SESSION","IDENTITY","SURFACE","PREPARE_ONLY","PREPARE_ONLY","PREPARE_ONLY","VERIFICATION"]){
    await service.run("route",key,"release-a",`2026-08-27T08:${String(store.records.length).padStart(2,"0")}:00.000Z`);
  }
  assert.equal(service.readiness("route",{releaseSha:"release-a"}).prepareOnlyPasses,3);
  const current=service.readiness("route",{releaseSha:"release-b"});
  assert.equal(current.sourcePassed,false);
  assert.equal(current.prepareOnlyPasses,0);
  assert.equal(current.verificationPassed,false);
});

test("surface-sensitive evidence older than current contract version is invalidated",async()=>{
  const store=new Store(),service=new RouteTestExecutionService(store,runner);
  await service.run("route","SOURCE","release","2026-08-27T08:00:00.000Z");
  await service.run("route","SESSION","release","2026-08-27T08:01:00.000Z");
  await service.run("route","IDENTITY","release","2026-08-27T08:02:00.000Z");
  await service.run("route","SURFACE","release","2026-08-27T08:03:00.000Z");
  for(const minute of [4,5,6])await service.run("route","PREPARE_ONLY","release",`2026-08-27T08:0${minute}:00.000Z`);
  await service.run("route","VERIFICATION","release","2026-08-27T08:07:00.000Z");
  const stale=service.readiness("route",{releaseSha:"release",surfaceRecordedAt:"2026-08-27T09:00:00.000Z",surfaceContractId:"surface-new"});
  assert.equal(stale.sourcePassed,true,"source evidence is not surface-specific");
  assert.equal(stale.sessionPassed,true);
  assert.equal(stale.identityPassed,true);
  assert.equal(stale.prepareOnlyPasses,0);
  assert.equal(stale.verificationPassed,false);
  assert.equal(stale.surfaceContractId,"surface-new");
});
