import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqliteControlPlaneStore } from "../dist/adapters/storage/sqlite.js";
import { ControlPlaneRuntimeCycleLeaseAdapter, RuntimeCycleAlreadyActiveError, SqliteRuntimeCycleReportStore, RuntimeCycleReportConflictError } from "../dist/adapters/runtime/sqlite-cycle-runtime.js";
import { FrozenRuntimeDueExecutionAdapter } from "../dist/adapters/runtime/safe-phase-adapters.js";
import { initializeWorkspaceRuntime } from "../dist/application/workspaces.js";
import { WorkspaceDistributionRuntime } from "../dist/adapters/runtime/workspace-distribution-runtime.js";

const actor={type:"test",id:"r7"};

test("workspace runtime cycle lease excludes a second worker and heartbeats",()=>{
  const root=mkdtempSync(join(tmpdir(),"flerdvision-cycle-lease-"));
  const store=new SqliteControlPlaneStore(join(root,"state.sqlite"));
  const adapter=new ControlPlaneRuntimeCycleLeaseAdapter(store,"workspace",180,()=>"2026-08-27T08:02:00.000Z");
  const first=adapter.acquire("worker-a","2026-08-27T08:00:00.000Z");
  assert.throws(()=>adapter.acquire("worker-b","2026-08-27T08:00:10.000Z"),RuntimeCycleAlreadyActiveError);
  first.heartbeat("2026-08-27T08:01:00.000Z");
  first.release("2026-08-27T08:02:00.000Z");
  const second=adapter.acquire("worker-b","2026-08-27T08:02:01.000Z");
  second.release("2026-08-27T08:02:02.000Z");
  store.close();
});

test("R0 frozen due adapter observes due work without claiming or changing SCHEDULED state",async()=>{
  const root=mkdtempSync(join(tmpdir(),"flerdvision-frozen-due-"));
  const store=new SqliteControlPlaneStore(join(root,"state.sqlite"));
  const intent={intentId:"intent-1",contentId:"content",creatorId:"creator",platform:"instagram",accountId:"account",format:"reel",copyVersionId:"v1",scheduledFor:"2026-08-27T09:00:00.000Z",idempotencyKey:"key-1"};
  store.createOrGetIntent(intent,"2026-08-27T08:00:00.000Z",actor);
  store.transitionIntent(intent.intentId,"READY","2026-08-27T08:00:01.000Z",actor,"test_ready");
  store.reserveIntent(intent.intentId,{reservationId:"res-1",intentId:intent.intentId,accountId:intent.accountId,platform:intent.platform,businessDate:"2026-08-27",slotKey:"slot-09",targetAt:"2026-08-27T09:00:00.000Z",windowStartAt:"2026-08-27T08:30:00.000Z",windowEndAt:"2026-08-27T09:30:00.000Z",createdAt:"2026-08-27T08:00:02.000Z"},"2026-08-27T08:00:02.000Z",actor);
  assert.equal(store.getIntent(intent.intentId).state,"SCHEDULED");
  const report=await new FrozenRuntimeDueExecutionAdapter(store).runDue("2026-08-27T09:01:00.000Z");
  assert.equal(report.frozen,1);
  assert.equal(report.claimed,0);
  assert.equal(store.getIntent(intent.intentId).state,"SCHEDULED");
  store.close();
});

test("cycle reports are append-only and conflict on reused id with different payload",()=>{
  const root=mkdtempSync(join(tmpdir(),"flerdvision-cycle-report-"));
  const store=new SqliteRuntimeCycleReportStore(join(root,"state.sqlite"),"workspace");
  const report={cycleId:"cycle-1",ownerId:"worker",startedAt:"2026-08-27T08:00:00.000Z",finishedAt:"2026-08-27T08:00:01.000Z",businessDate:"2026-08-27",phases:[],healthy:true};
  store.record(report); store.record(report);
  assert.equal(store.latest().length,1);
  assert.throws(()=>store.record({...report,healthy:false}),RuntimeCycleReportConflictError);
  store.close();
});

test("composed workspace supervisor completes a full R0-frozen cycle and persists the report",async()=>{
  const root=mkdtempSync(join(tmpdir(),"flerdvision-runtime-composed-"));
  initializeWorkspaceRuntime(root,"workspace");
  const runtime=new WorkspaceDistributionRuntime({runtimeRoot:root,workspaceId:"workspace",env:{...process.env,FFPROBE_EXECUTABLE_PATH:"ffprobe"}});
  try{
    const times=["2026-08-27T08:00:01.000Z","2026-08-27T08:00:02.000Z","2026-08-27T08:00:03.000Z","2026-08-27T08:00:04.000Z","2026-08-27T08:00:05.000Z","2026-08-27T08:00:06.000Z","2026-08-27T08:00:07.000Z","2026-08-27T08:00:08.000Z","2026-08-27T08:00:09.000Z"];
    const clock=()=>times.shift()??"2026-08-27T08:00:10.000Z";
    const report=await runtime.supervisor("worker",clock).runCycle("2026-08-27T08:00:00.000Z","2026-08-27");
    assert.equal(report.phases.length,7);
    assert.equal(report.phases.find((phase)=>phase.phase==="DUE_EXECUTION").status,"PASS");
    assert.match(report.phases.find((phase)=>phase.phase==="DUE_EXECUTION").summary,/held by live freeze/);
    assert.equal(runtime.reports.latest(1)[0].cycleId,report.cycleId);
  }finally{runtime.close();}
});
