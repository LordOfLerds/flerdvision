import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PollingRuntimeSourceScanAdapter } from "../dist/application/runtime-polling-source.js";
import { SqliteSourcePollingStateStore } from "../dist/adapters/distribution/sqlite-source-poll-state.js";
import { DEFAULT_DISTRIBUTION_RUNTIME_POLICY } from "../dist/domain/distribution-operations.js";

function config(){return{load(){return{revision:0,updatedAt:"2026-08-27T08:00:00.000Z",config:{sources:[],lanes:[],postingProfiles:[],copyProfiles:[],routes:[],activationCursors:[]},schedulePolicies:{},planningPolicy:{contentOrder:"FILENAME_NUMERIC_PREFIX",lateArrival:"NEXT_AVAILABLE_SLOT",overflow:"BACKLOG_NEXT_DAY"},runtimePolicy:structuredClone(DEFAULT_DISTRIBUTION_RUNTIME_POLICY)};}};}

test("manual source scan in one process postpones interval scan in another process",async()=>{
  const root=mkdtempSync(join(tmpdir(),"flerdvision-poll-state-")),db=join(root,"state.sqlite");
  const storeA=new SqliteSourcePollingStateStore(db),storeB=new SqliteSourcePollingStateStore(db);
  let scansA=0,scansB=0;
  const a=new PollingRuntimeSourceScanAdapter({async scan(){scansA+=1;return{observed:1,ready:1,stabilizing:0,blocked:0};}},config(),storeA);
  const b=new PollingRuntimeSourceScanAdapter({async scan(){scansB+=1;return{observed:2,ready:2,stabilizing:0,blocked:0};}},config(),storeB);
  await a.forceScan("2026-08-27T10:00:00.000Z","MANUAL");
  const shared=storeB.get();
  assert.equal(shared.lastTrigger,"MANUAL");
  assert.equal(shared.lastPollAt,"2026-08-27T10:00:00.000Z");
  assert.equal(shared.nextPollAt,"2026-08-27T10:05:00.000Z");
  const skipped=await b.scan("2026-08-27T10:01:00.000Z");
  assert.deepEqual(skipped,{observed:0,ready:0,stabilizing:0,blocked:0});
  assert.equal(scansA,1);
  assert.equal(scansB,0,"second process must honor the manual scan's durable cadence");
  await b.scan("2026-08-27T10:05:00.000Z");
  assert.equal(scansB,1);
  const after=storeA.get();
  assert.equal(after.lastTrigger,"INTERVAL");
  assert.equal(after.lastPollAt,"2026-08-27T10:05:00.000Z");
  storeA.close();storeB.close();
});
