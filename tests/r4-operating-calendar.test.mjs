import test from "node:test";
import assert from "node:assert/strict";
import { DistributionPlanner } from "../dist/application/distribution-planner.js";
import { projectContentDemand } from "../dist/application/content-demand.js";
import { DEFAULT_SCHEDULING_POLICY } from "../dist/domain/scheduling.js";

function stored(){
  return{
    revision:1,updatedAt:"2026-08-27T08:00:00.000Z",
    config:{
      sources:[{connectionId:"src",displayName:"Source",kind:"local_folder",rootRef:"/tmp",enabled:true,disposition:{mode:"database_only",leavePartialUntouched:true,leaveBlockedUntouched:true}}],
      lanes:[{laneId:"lane",connectionId:"src",displayName:"Lane",creatorId:"creator",folderRef:"lane",folderPath:"Lane",interpretation:{kind:"flat"},enabled:true}],
      activationCursors:[{laneId:"lane",mode:"IMPORT_BACKLOG",activatedAt:"2026-08-27T08:00:00.000Z"}],
      postingProfiles:[{postingProfileId:"ig",displayName:"IG",platform:"instagram",format:"reel",commentsEnabled:true,shareToFeed:true,crosspostFacebook:false,enabled:true}],
      copyProfiles:[{copyProfileId:"copy",displayName:"Copy",versionId:"v1",strategy:"static",enabled:true}],
      routes:[{routeId:"route",displayName:"Route",laneId:"lane",accountId:"acc",platform:"instagram",postingProfileId:"ig",copyProfileId:"copy",schedulePolicyId:"four",operatingCalendarId:"weekday",requirement:"REQUIRED",enabled:true}]
    },
    schedulePolicies:{
      four:{...DEFAULT_SCHEDULING_POLICY},
      two:{...DEFAULT_SCHEDULING_POLICY,slots:[{key:"s1",localTime:"09:00"},{key:"s2",localTime:"15:00"}],maxPerAccountPerBusinessDate:2,minimumSpacingMinutes:240}
    },
    operatingCalendars:[{calendarId:"weekday",displayName:"Week",enabled:true,weekdayRules:[{isoWeekday:4,active:true,schedulePolicyId:"four"},{isoWeekday:5,active:true,schedulePolicyId:"two"},{isoWeekday:6,active:false},{isoWeekday:7,active:false}],dateOverrides:[{businessDate:"2026-08-28",active:true,schedulePolicyId:"four",note:"campaign override"}]}],
    planningPolicy:{contentOrder:"FILENAME_NUMERIC_PREFIX",lateArrival:"NEXT_AVAILABLE_SLOT",overflow:"BACKLOG_NEXT_DAY"}
  };
}
function asset(id,date){return{assetId:id,contentId:`c-${id}`,laneId:"lane",creatorId:"creator",sourceObservationId:`o-${id}`,sourceRef:`file://${id}`,externalObjectId:id,filename:`${id}.mp4`,mediaFingerprint:`fp-${id}`,observedAt:`${date}T06:00:00.000Z`,readyAt:`${date}T06:10:00.000Z`,scheduledBusinessDate:date,state:"READY",metadata:{}};}

test("calendar can switch rhythm or disable a route without changing route identity",()=>{
  const s=stored(),catalog={postingProfiles:{ig:s.config.postingProfiles[0]},copyProfiles:{copy:s.config.copyProfiles[0]},schedulePolicies:s.schedulePolicies,operatingCalendars:{weekday:s.operatingCalendars[0]}};
  const planner=new DistributionPlanner();
  const thursday=planner.plan({businessDate:"2026-08-27",generatedAt:"2026-08-27T06:20:00.000Z",assets:[1,2,3,4].map(n=>asset(String(n),"2026-08-27")),lanes:s.config.lanes,routes:s.config.routes,catalog,policy:s.planningPolicy});
  assert.equal(thursday.deliveries.length,4);
  const friday=planner.plan({businessDate:"2026-08-28",generatedAt:"2026-08-28T06:20:00.000Z",assets:[1,2,3,4].map(n=>asset(String(n),"2026-08-28")),lanes:s.config.lanes,routes:s.config.routes,catalog,policy:s.planningPolicy});
  assert.equal(friday.deliveries.length,4,"date override wins over weekday two-slot rhythm");
  const saturday=planner.plan({businessDate:"2026-08-29",generatedAt:"2026-08-29T06:20:00.000Z",assets:[asset("1","2026-08-29")],lanes:s.config.lanes,routes:s.config.routes,catalog,policy:s.planningPolicy});
  assert.equal(saturday.deliveries.length,0);
  assert.equal(saturday.gaps.length,0,"calendar-off day is not missing content");
});

test("content demand follows effective calendar and crosspost source demand stays max not sum",()=>{
  const s=stored();
  s.config.routes.push({...s.config.routes[0],routeId:"route-tt",accountId:"tt",platform:"tiktok",postingProfileId:"tt"});
  s.config.postingProfiles.push({postingProfileId:"tt",displayName:"TT",platform:"tiktok",format:"tiktok",visibility:"everyone",commentsEnabled:true,duetEnabled:true,stitchEnabled:true,enabled:true});
  const thursday=projectContentDemand(s,[1,2,3].map(n=>asset(String(n),"2026-08-27")),"2026-08-27");
  assert.equal(thursday.lanes[0].requiredAssetCount,4);
  assert.equal(thursday.lanes[0].missingRequiredAssetCount,1);
  const saturday=projectContentDemand(s,[],"2026-08-29");
  assert.equal(saturday.lanes.length,0,"no active required route means no false missing-content warning");
});
