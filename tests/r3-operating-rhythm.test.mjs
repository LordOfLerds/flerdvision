import test from "node:test";
import assert from "node:assert/strict";
import { decideSourcePoll } from "../dist/domain/distribution-operations.js";
import { projectContentDemand } from "../dist/application/content-demand.js";
import { planReadinessAttention } from "../dist/application/readiness-notification-planner.js";
import { reconcileDailyPlanWithCommitments } from "../dist/application/daily-plan-commitments.js";
import { DEFAULT_SCHEDULING_POLICY } from "../dist/domain/scheduling.js";

function stored(){
  return{
    revision:1,updatedAt:"2026-08-27T06:00:00.000Z",
    config:{
      sources:[{connectionId:"src",displayName:"Drive",kind:"google_drive",rootRef:"root",enabled:true,disposition:{mode:"database_only",leavePartialUntouched:true,leaveBlockedUntouched:true}}],
      lanes:[{laneId:"lane",connectionId:"src",displayName:"Piet",folderRef:"folder",folderPath:"Piet/Mittwoch",creatorId:"piet",interpretation:{kind:"flat"},enabled:true}],
      activationCursors:[{laneId:"lane",mode:"IMPORT_BACKLOG",activatedAt:"2026-08-27T06:00:00.000Z"}],
      postingProfiles:[
        {postingProfileId:"ig",displayName:"IG Normal",platform:"instagram",format:"reel",commentsEnabled:true,shareToFeed:true,crosspostFacebook:false,enabled:true},
        {postingProfileId:"tt",displayName:"TikTok Public",platform:"tiktok",format:"tiktok",visibility:"everyone",commentsEnabled:true,duetEnabled:true,stitchEnabled:true,enabled:true}
      ],
      copyProfiles:[{copyProfileId:"copy",displayName:"Copy",versionId:"v1",strategy:"static",enabled:true}],
      routes:[
        {routeId:"ig-route",displayName:"Instagram",laneId:"lane",accountId:"ig-account",platform:"instagram",postingProfileId:"ig",copyProfileId:"copy",schedulePolicyId:"standard",requirement:"REQUIRED",enabled:true},
        {routeId:"tt-route",displayName:"TikTok",laneId:"lane",accountId:"tt-account",platform:"tiktok",postingProfileId:"tt",copyProfileId:"copy",schedulePolicyId:"standard",requirement:"REQUIRED",enabled:true}
      ]
    },
    schedulePolicies:{standard:DEFAULT_SCHEDULING_POLICY},
    planningPolicy:{contentOrder:"FILENAME_NUMERIC_PREFIX",lateArrival:"NEXT_AVAILABLE_SLOT",overflow:"BACKLOG_NEXT_DAY"}
  };
}
function asset(id,date="2026-08-27",state="READY"){
  return{assetId:id,contentId:`content-${id}`,laneId:"lane",creatorId:"piet",sourceObservationId:`obs-${id}`,sourceRef:`gdrive://file/${id}`,externalObjectId:id,filename:`${id}.mp4`,mediaFingerprint:`fp-${id}`,observedAt:"2026-08-27T06:00:00.000Z",state,readyAt:"2026-08-27T06:10:00.000Z",scheduledBusinessDate:date,metadata:{}};
}
function delivery(id,routeId="ig-route",assetId="a1",slotKey="slot-2",scheduledFor="2026-08-27T09:00:00.000Z"){
  return{deliveryId:id,routeId,assetId,contentId:`content-${assetId}`,creatorId:"piet",laneId:"lane",accountId:"ig-account",platform:"instagram",format:"reel",postingProfileId:"ig",copyProfileId:"copy",copyVersionId:"v1",schedulePolicyId:"standard",requirement:"REQUIRED",businessDate:"2026-08-27",slotKey,scheduledFor,windowStartAt:"2026-08-27T08:30:00.000Z",windowEndAt:"2026-08-27T09:30:00.000Z"};
}

test("source polling is five minutes in the active window and does not run every control tick",()=>{
  const policy={timeZone:"Europe/Vienna",activeWindowStartLocal:"06:00",activeWindowEndLocal:"19:00",activeIntervalMinutes:5,idleIntervalMinutes:30,pollImmediatelyOnStartup:true};
  const notDue=decideSourcePoll({now:"2026-08-27T05:00:00.000Z",lastPollAt:"2026-08-27T04:56:00.000Z",policy}); // 07:00 local
  assert.equal(notDue.due,false);
  const due=decideSourcePoll({now:"2026-08-27T05:02:00.000Z",lastPollAt:"2026-08-27T04:56:00.000Z",policy});
  assert.equal(due.due,true);
  assert.equal(due.intervalMinutes,5);
});

test("crossposting four slots to Instagram and TikTok needs four source assets, not eight",()=>{
  const demand=projectContentDemand(stored(),[asset("1"),asset("2"),asset("3")],"2026-08-27");
  assert.equal(demand.lanes[0].requiredAssetCount,4);
  assert.equal(demand.lanes[0].readyAssetCount,3);
  assert.equal(demand.lanes[0].missingRequiredAssetCount,1);
  assert.equal(demand.lanes[0].status,"MISSING");
});

test("carry-over asset in the current plan counts toward today's demand",()=>{
  const carry=asset("carry","2026-08-26");
  const plan={planId:"p",businessDate:"2026-08-27",generatedAt:"2026-08-27T06:00:00.000Z",deliveries:[delivery("d-carry","ig-route","carry")],gaps:[],backlog:[]};
  const demand=projectContentDemand(stored(),[carry,asset("2"),asset("3"),asset("4")],"2026-08-27",plan);
  assert.equal(demand.lanes[0].readyAssetCount,4);
  assert.equal(demand.lanes[0].status,"ENOUGH");
});

test("morning content shortage becomes one deterministic attention item",()=>{
  const configuration=stored();
  const demand=projectContentDemand(configuration,[asset("1"),asset("2")],"2026-08-27");
  const plan={planId:"p",businessDate:"2026-08-27",generatedAt:"2026-08-27T06:00:00.000Z",deliveries:[],gaps:[],backlog:[]};
  const attention=planReadinessAttention({now:"2026-08-27T06:05:00.000Z",businessDate:"2026-08-27",stored:configuration,demand,plan}); // 08:05 Vienna
  assert.equal(attention.length,1);
  assert.equal(attention[0].attention.kind,"MORNING_CONTENT");
  assert.equal(attention[0].attention.severity,"ACTION_REQUIRED");
  // Two channels share this lane, so the message names neither rather than the wrong one.
  assert.equal(attention[0].attention.accountId,undefined);
});

test("a lane that feeds exactly one channel lends the morning message that channel",()=>{
  const configuration=stored();
  configuration.config.routes=configuration.config.routes.filter((route)=>route.routeId==="ig-route");
  const demand=projectContentDemand(configuration,[],"2026-08-27");
  const plan={planId:"p",businessDate:"2026-08-27",generatedAt:"2026-08-27T06:00:00.000Z",deliveries:[],gaps:[],backlog:[]};
  const attention=planReadinessAttention({now:"2026-08-27T06:05:00.000Z",businessDate:"2026-08-27",stored:configuration,demand,plan});
  // Without the account the message cannot name the channel, and without the channel it cannot
  // offer the Drive folder the operator is being asked to fill.
  assert.equal(attention[0].attention.accountId,"ig-account");
});

test("replanning preserves a reserved assignment and suppresses a replacement in the same route slot",()=>{
  const committed=delivery("committed","ig-route","a1","slot-2","2026-08-27T09:00:00.000Z");
  const replacement=delivery("replacement","ig-route","new-asset","slot-2","2026-08-27T09:00:00.000Z");
  const candidate={planId:"candidate",businessDate:"2026-08-27",generatedAt:"2026-08-27T07:20:00.000Z",deliveries:[replacement],gaps:[],backlog:[]};
  const result=reconcileDailyPlanWithCommitments(candidate,[{delivery:committed,intentId:"intent-1",reservationId:"res-1",state:"SCHEDULED"}]);
  assert.deepEqual(result.plan.deliveries.map((item)=>item.deliveryId),["committed"]);
  assert.equal(result.suppressed[0].reason,"ROUTE_SLOT_COMMITTED");
});
