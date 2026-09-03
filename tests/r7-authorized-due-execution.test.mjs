import test from "node:test";
import assert from "node:assert/strict";
import { SqliteControlPlaneStore } from "../dist/adapters/storage/sqlite.js";
import { AuthorizedRuntimeDueExecutionAdapter } from "../dist/adapters/runtime/authorized-due-execution.js";
import { PublicationScheduler } from "../dist/application/scheduler.js";
import { instantForLocalDateTime } from "../dist/domain/scheduling.js";

const setupActor={type:"test",id:"due-worker-test"},target=instantForLocalDateTime("2026-08-27","09:00","Europe/Vienna");
function setup(){const store=new SqliteControlPlaneStore(":memory:");store.registerSocialAccount({accountId:"acct",platform:"instagram",expectedHandle:"acct",enabled:true},"2026-08-27T06:00:00Z",setupActor);store.registerBrowserIdentity({identityId:"browser",accountId:"acct",platform:"instagram",profileKey:"ig/acct",expectedHandle:"acct",enabled:true},"2026-08-27T06:00:01Z",setupActor);store.createOrGetIntent({intentId:"intent",contentId:"content",creatorId:"creator",platform:"instagram",accountId:"acct",format:"reel",copyVersionId:"copy",scheduledFor:target,idempotencyKey:"idem"},"2026-08-27T06:00:02Z",setupActor);store.transitionIntent("intent","READY","2026-08-27T06:00:03Z",setupActor);new PublicationScheduler(store).scheduleIntent("intent","2026-08-27T06:00:04Z",setupActor);return store;}
function clock(){let n=0;return()=>new Date(new Date(target).getTime()+n++*1000).toISOString();}
function gate(){return{evaluate(){return{allowed:true,blockingSwitches:[]};},assertAllowed(){}};}
function publisher(store){let clicks=0,closed=0;return{get clicks(){return clicks;},get closed(){return closed;},prepare:{async prepareClaimed(intentId,at,actor){return store.recordPreparedAttempt({attemptId:"attempt",intentId,browserIdentityId:"browser",releaseSha:"release-1",startedAt:at,finishedAt:at,result:"prepared",reachedFinalActionBoundary:true},actor);}},finalAction:{async invoke(intent,attempt){clicks+=1;return{invokedAt:new Date(target).toISOString(),finishedAt:new Date(new Date(target).getTime()+1000).toISOString(),evidence:[{evidenceId:"receipt",intentId:intent.intentId,attemptId:attempt.attemptId,kind:"ui_receipt",observedAt:new Date(new Date(target).getTime()+1000).toISOString(),positive:true}]};}},reconciliation:{async reconcile(intentId,attemptId,actor){store.transitionIntent(intentId,"VERIFIED",new Date(new Date(target).getTime()+2000).toISOString(),actor,"fixture_verified");return{decision:{decisionId:"d",intentId,attemptId,decidedAt:new Date(new Date(target).getTime()+2000).toISOString(),outcome:"VERIFIED",policyName:"fixture",evidenceIds:["receipt"],reason:"fixture"},collectorErrors:[]};}},registry:{async close(){closed+=1;}}};}

test("authorized dormant due worker follows PREPARING -> PUBLISHING -> VERIFYING -> VERIFIED",async()=>{const store=setup(),pub=publisher(store),now=clock();try{const worker=new AuthorizedRuntimeDueExecutionAdapter(store,pub,gate(),()=>({mode:"canary",allowFinalPublish:true,allowedAccountIds:new Set(["acct"]),releaseSha:"release-1"}),{releaseSha:"release-1",ownerId:"worker",clock:now,maxPerCycle:2,launchJitterMaxSeconds:0});const report=await worker.runDue(target);assert.deepEqual(report,{claimed:1,prepared:1,verified:1,uncertain:0,blocked:0,waived:0,waivedIntentIds:[]});assert.equal(store.getIntent("intent")?.state,"VERIFIED");assert.equal(pub.clicks,1);}finally{store.close();}});
test("release mismatch blocks before irreversible final click",async()=>{const store=setup(),pub=publisher(store),now=clock();try{const worker=new AuthorizedRuntimeDueExecutionAdapter(store,pub,gate(),()=>({mode:"canary",allowFinalPublish:true,allowedAccountIds:new Set(["acct"]),releaseSha:"wrong-release"}),{releaseSha:"release-1",ownerId:"worker",clock:now,maxPerCycle:1,launchJitterMaxSeconds:0});const report=await worker.runDue(target);assert.equal(report.blocked,1);assert.equal(pub.clicks,0);assert.equal(pub.closed,1);assert.equal(store.getIntent("intent")?.state,"BLOCKED");assert.equal(store.getPublishAttempt("attempt")?.irreversibleBoundaryEnteredAt,undefined);}finally{store.close();}});

test("B1: a due intent outside the account allowlist is never claimed and stays SCHEDULED", async () => {
  // Before this fix the worker claimed foreign due intents, ran the full browser prepare, and
  // only then failed the allowlist -- burning the intent to BLOCKED for its rightful worker.
  const store = setup();
  try {
    const worker = new AuthorizedRuntimeDueExecutionAdapter(
      store,
      { prepare: { async prepareClaimed() { throw new Error("must not prepare foreign work"); } },
        finalAction: {}, reconciliation: {}, registry: { async close() {} } },
      gate(),
      () => ({ mode: "canary", allowFinalPublish: true, allowedAccountIds: new Set(["someone-else"]), releaseSha: "release-1" }),
      { ownerId: "worker-1", releaseSha: "release-1", clock: clock() }
    );
    const report = await worker.runDue(target);
    assert.equal(report.claimed, 0);
    assert.equal(report.blocked, 0);
    assert.equal(store.getIntent("intent")?.state, "SCHEDULED");
  } finally { store.close(); }
});
