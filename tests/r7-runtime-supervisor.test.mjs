import test from "node:test";
import assert from "node:assert/strict";
import { RuntimeSupervisor } from "../dist/application/runtime-supervisor.js";

function fixture(overrides={}){
  const calls=[],reports=[];let locked=false;
  const ports={
    lease:{acquire(){if(locked)throw new Error("cycle already leased");locked=true;return{release(){locked=false;}}}},
    source:{async scan(){calls.push("source");return{observed:2,ready:2,stabilizing:0,blocked:0}}},
    planner:{async ensureDailyPlan(date){calls.push("plan");return{planId:"p",businessDate:date,generatedAt:"2026-08-27T07:00:00Z",deliveries:[],gaps:[],backlog:[]}}},
    intents:{async ensureIntents(){calls.push("intents");return{created:0,existing:0,blocked:0}}},
    due:{async runDue(){calls.push("due");return{claimed:0,prepared:0,verified:0,uncertain:0,blocked:0}}},
    reconciliation:{async reconcile(){calls.push("reconcile");return{inspected:0,verified:0,safeToRetry:0,stillUncertain:0}}},
    disposition:{async applyEligible(){calls.push("disposition");return{inspected:0,completed:0,externalMutations:0,manualReview:0}}},
    operations:{async projectAndNotify(){calls.push("ops");return{incidentsCreated:0,notificationsEnqueued:0}}},
    reports:{record(r){reports.push(r)}},...overrides
  };return{ports,calls,reports};
}

test("supervisor executes source -> plan -> intents then due/reconciliation/disposition/ops",async()=>{
  const f=fixture();const report=await new RuntimeSupervisor(f.ports,"worker").runCycle("2026-08-27T07:00:00Z","2026-08-27");
  assert.deepEqual(f.calls,["source","plan","intents","due","reconcile","disposition","ops"]);
  assert.equal(report.healthy,true);assert.equal(f.reports.length,1);
});

test("source failure skips new planning but still runs due work, reconciliation and operations",async()=>{
  const f=fixture({source:{async scan(){f.calls.push("source");throw new Error("Drive unavailable")}}});
  const report=await new RuntimeSupervisor(f.ports,"worker").runCycle("2026-08-27T07:00:00Z","2026-08-27");
  assert.deepEqual(f.calls,["source","due","reconcile","disposition","ops"]);
  assert.equal(report.phases.find(p=>p.phase==="PLAN").status,"SKIPPED");
  assert.equal(report.phases.find(p=>p.phase==="SOURCE_SCAN").status,"FAIL");
  assert.equal(report.healthy,false);
});

test("due execution failure cannot suppress reconciliation or incident projection",async()=>{
  const f=fixture({due:{async runDue(){f.calls.push("due");throw new Error("browser died")}}});
  const report=await new RuntimeSupervisor(f.ports,"worker").runCycle("2026-08-27T07:00:00Z","2026-08-27");
  assert.ok(f.calls.indexOf("reconcile")>f.calls.indexOf("due"));
  assert.ok(f.calls.includes("ops"));
  assert.equal(report.phases.find(p=>p.phase==="DUE_EXECUTION").status,"FAIL");
});

test("cycle lease prevents overlapping supervisor runs",async()=>{
  let releaseFirst;const base=fixture();
  base.ports.lease={acquire(){if(releaseFirst)throw new Error("cycle already leased");releaseFirst=()=>{releaseFirst=undefined};return{release(){releaseFirst?.()}}}};
  const lease=base.ports.lease.acquire("x","2026-08-27T07:00:00Z");
  await assert.rejects(()=>new RuntimeSupervisor(base.ports,"worker").runCycle("2026-08-27T07:00:00Z","2026-08-27"),/cycle already leased/);
  lease.release();
});

test("supervisor has no generic retry-after-uncertain phase",async()=>{
  const f=fixture({due:{async runDue(){f.calls.push("due");return{claimed:1,prepared:1,verified:0,uncertain:1,blocked:0}}},reconciliation:{async reconcile(){f.calls.push("reconcile");return{inspected:1,verified:0,safeToRetry:0,stillUncertain:1}}}});
  const report=await new RuntimeSupervisor(f.ports,"worker").runCycle("2026-08-27T07:00:00Z","2026-08-27");
  assert.equal(report.phases.some(p=>p.phase.includes("RETRY")),false);
  assert.deepEqual(f.calls,["source","plan","intents","due","reconcile","disposition","ops"]);
});
