import test from "node:test";
import assert from "node:assert/strict";
import { SqliteControlPlaneStore } from "../dist/adapters/storage/sqlite.js";
import { AuthorizedRuntimeDueExecutionAdapter } from "../dist/adapters/runtime/authorized-due-execution.js";
import { PublicationScheduler } from "../dist/application/scheduler.js";
import { instantForLocalDateTime } from "../dist/domain/scheduling.js";

const actor={type:"test",id:"due-isolation"};
const target=instantForLocalDateTime("2026-09-05","12:00","Europe/Vienna");

function addDue(store,{accountId,platform}){
  const identityId=`browser:${accountId}`;
  const intentId=`intent:${accountId}`;
  store.registerSocialAccount({accountId,platform,expectedHandle:accountId,enabled:true},"2026-09-05T08:00:00Z",actor);
  store.registerBrowserIdentity({identityId,accountId,platform,profileKey:`${platform}/${accountId}`,expectedHandle:accountId,enabled:true},"2026-09-05T08:00:01Z",actor);
  store.createOrGetIntent({intentId,contentId:`content:${accountId}`,creatorId:`creator:${accountId}`,platform,accountId,format:platform==="youtube"?"short":"reel",copyVersionId:`copy:${accountId}`,scheduledFor:target,idempotencyKey:`idem:${accountId}`},"2026-09-05T08:00:02Z",actor);
  store.transitionIntent(intentId,"READY","2026-09-05T08:00:03Z",actor);
  new PublicationScheduler(store).scheduleIntent(intentId,"2026-09-05T08:00:04Z",actor);
  return{identityId,intentId};
}

async function waitFor(predicate,timeoutMs=500){
  const started=Date.now();
  while(Date.now()-started<timeoutMs){
    if(predicate())return;
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  throw new Error("condition was not reached before timeout");
}

test("a stalled YouTube account does not prevent Instagram from reaching VERIFIED",async()=>{
  const store=new SqliteControlPlaneStore(":memory:");
  const ig=addDue(store,{accountId:"ig-account",platform:"instagram"});
  const yt=addDue(store,{accountId:"yt-account",platform:"youtube"});
  let releaseYouTube;
  const youtubeGate=new Promise(resolve=>{releaseYouTube=resolve;});
  let clockTick=0;
  const clock=()=>new Date(new Date(target).getTime()+clockTick++*100).toISOString();
  const publisher={
    prepare:{async prepareClaimed(intentId,at,runActor){
      if(intentId===yt.intentId)await youtubeGate;
      const record=store.getIntent(intentId);
      const identityId=record?.intent.accountId==="ig-account"?ig.identityId:yt.identityId;
      return store.recordPreparedAttempt({attemptId:`attempt:${intentId}`,intentId,browserIdentityId:identityId,releaseSha:"release-1",startedAt:at,finishedAt:at,result:"prepared",reachedFinalActionBoundary:true},runActor);
    }},
    finalAction:{async invoke(intent,attempt){return{invokedAt:clock(),finishedAt:clock(),evidence:[{evidenceId:`receipt:${intent.intentId}`,intentId:intent.intentId,attemptId:attempt.attemptId,kind:"ui_receipt",observedAt:clock(),positive:true}]};}},
    reconciliation:{async reconcile(intentId,attemptId,runActor){
      store.transitionIntent(intentId,"VERIFIED",clock(),runActor,"fixture_verified");
      return{decision:{decisionId:`decision:${intentId}`,intentId,attemptId,decidedAt:clock(),outcome:"VERIFIED",policyName:"fixture",evidenceIds:[`receipt:${intentId}`],reason:"fixture"},collectorErrors:[]};
    }},
    registry:{async close(){}}
  };
  const gate={evaluate(){return{allowed:true,blockingSwitches:[]};},assertAllowed(){}};
  const worker=new AuthorizedRuntimeDueExecutionAdapter(
    store,publisher,gate,
    ()=>({mode:"canary",allowFinalPublish:true,allowedAccountIds:new Set(["ig-account","yt-account"]),releaseSha:"release-1"}),
    {releaseSha:"release-1",ownerId:"worker",clock,maxPerCycle:2}
  );
  try{
    const running=worker.runDue(target);
    await waitFor(()=>store.getIntent(ig.intentId)?.state==="VERIFIED");
    assert.equal(store.getIntent(ig.intentId)?.state,"VERIFIED");
    assert.equal(store.getIntent(yt.intentId)?.state,"PREPARING");
    releaseYouTube();
    const report=await running;
    assert.equal(report.claimed,2);
    assert.equal(report.verified,2);
    assert.equal(store.getIntent(yt.intentId)?.state,"VERIFIED");
  }finally{store.close();}
});
