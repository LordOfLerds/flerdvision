import test from "node:test";
import assert from "node:assert/strict";
import { projectWorkflowCenter } from "../dist/application/workflow-center.js";

function fixture({qualified=true}={}){
  const stored={
    revision:1,updatedAt:"2026-08-27T15:00:00.000Z",
    config:{
      sources:[{connectionId:"src",displayName:"Drive",kind:"google_drive",rootRef:"root",enabled:true,disposition:{mode:"database_only",leavePartialUntouched:true,leaveBlockedUntouched:true}}],
      lanes:[{laneId:"lane",connectionId:"src",displayName:"Daily",creatorId:"creator",folderRef:"folder",folderPath:"Daily",interpretation:{kind:"flat"},enabled:true}],
      postingProfiles:[{postingProfileId:"ig-story",displayName:"IG Story",platform:"instagram",format:"story",commentsEnabled:false,shareToFeed:false,crosspostFacebook:false,enabled:true}],
      copyProfiles:[{copyProfileId:"copy",displayName:"Copy",versionId:"v1",strategy:"static",enabled:true}],
      routes:[{routeId:"route-story",displayName:"Daily → Story",laneId:"lane",accountId:"ig",platform:"instagram",postingProfileId:"ig-story",copyProfileId:"copy",schedulePolicyId:"default",requirement:"REQUIRED",enabled:true}],
      activationCursors:[{laneId:"lane",mode:"NEW_ONLY",activatedAt:"2026-08-27T12:00:00.000Z"}]
    },
    schedulePolicies:{default:{timeZone:"Europe/Vienna",slots:[{key:"story",localTime:"18:00"}],windowMinutes:30,maxPerAccountPerBusinessDate:4,minimumSpacingMinutes:120,overflowAllowed:false,overflowMinimumSpacingMinutes:240}},
    planningPolicy:{contentOrder:"OBSERVED_AT",lateArrival:"NEXT_DAY",overflow:"BACKLOG_NEXT_DAY"}
  };
  const runtime={
    plan:{planId:"plan",businessDate:"2026-08-27",generatedAt:"2026-08-27T12:00:00.000Z",deliveries:[],gaps:[],backlog:[]},
    accounts:[{accountId:"ig",platform:"instagram",expectedHandle:"demo",enabled:true}],
    channelReadiness:[{accountId:"ig",sessionHealth:qualified?"HEALTHY":"UNKNOWN",identityVerified:qualified}],
    surfaceReadiness:[{accountId:"ig",postingProfileId:"ig-story",surfaceContract:qualified?"CALIBRATED":"UNVERIFIED",contractId:"surface"}],
    routeTests:[{routeId:"route-story",sourcePassed:qualified,sessionPassed:qualified,identityPassed:qualified,prepareOnlyPasses:qualified?3:0,secretLivePassed:false,verificationPassed:qualified,cleanupPassed:false,releaseSha:"sha",surfaceContractId:"surface"}],
    assets:[],deliveryAggregates:[],runtimeCycles:[]
  };
  return{stored,runtime};
}

test("qualified daily Story is visible as SAFE_FROZEN rather than live-ready",()=>{
  const {stored,runtime}=fixture({qualified:true});
  const model=projectWorkflowCenter({stored,runtime,businessDate:"2026-08-27"});
  const story=model.cards.find(item=>item.workflowId==="daily-story");
  const qualification=model.cards.find(item=>item.workflowId==="route-qualification");
  assert.equal(story?.status,"SAFE_FROZEN");
  assert.equal(qualification?.status,"SAFE_FROZEN");
  assert.equal(model.cards.find(item=>item.workflowId==="metrics-tracker")?.status,"READY");
});

test("unqualified Story route remains actionable and never appears ready",()=>{
  const {stored,runtime}=fixture({qualified:false});
  const model=projectWorkflowCenter({stored,runtime,businessDate:"2026-08-27"});
  const story=model.cards.find(item=>item.workflowId==="daily-story");
  assert.equal(story?.status,"NEEDS_ACTION");
  assert.equal(story?.metrics.qualifiedStoryRoutes,0);
});
