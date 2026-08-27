import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqliteDistributionRuntimeStateStore } from "../dist/adapters/distribution/sqlite-runtime-state.js";
import { PersistedDistributionPlannerAdapter } from "../dist/application/runtime-source-planner-adapters.js";
import { DEFAULT_SCHEDULING_POLICY } from "../dist/domain/scheduling.js";

function asset(id,name,date){return{assetId:id,contentId:`content-${id}`,laneId:"lane",creatorId:"creator",sourceObservationId:`obs-${id}`,sourceRef:`file://${id}`,externalObjectId:id,filename:name,mediaFingerprint:`fp-${id}`,observedAt:"2026-08-27T06:00:00.000Z",state:"READY",readyAt:"2026-08-27T06:10:00.000Z",scheduledBusinessDate:date,metadata:{}};}
function config(){return{
  revision:1,updatedAt:"2026-08-27T06:00:00.000Z",
  config:{
    sources:[{connectionId:"src",displayName:"Source",kind:"local_folder",rootRef:"/tmp",enabled:true,disposition:{mode:"database_only",leavePartialUntouched:true,leaveBlockedUntouched:true}}],
    lanes:[{laneId:"lane",connectionId:"src",displayName:"Lane",folderRef:"lane",folderPath:"lane",interpretation:{kind:"flat"},enabled:true}],
    activationCursors:[{laneId:"lane",mode:"IMPORT_BACKLOG",activatedAt:"2026-08-27T05:00:00.000Z"}],
    postingProfiles:[{postingProfileId:"ig",displayName:"IG",platform:"instagram",format:"reel",commentsEnabled:true,shareToFeed:true,crosspostFacebook:false,enabled:true}],
    copyProfiles:[{copyProfileId:"copy",displayName:"Copy",versionId:"v1",strategy:"static",enabled:true}],
    routes:[{routeId:"route",displayName:"Route",laneId:"lane",accountId:"ig-account",platform:"instagram",postingProfileId:"ig",copyProfileId:"copy",schedulePolicyId:"one",requirement:"REQUIRED",enabled:true}]
  },
  schedulePolicies:{one:{...DEFAULT_SCHEDULING_POLICY,slots:[{key:"slot-1",localTime:"09:00"}],maxPerAccountPerBusinessDate:1}},
  planningPolicy:{contentOrder:"FILENAME_NUMERIC_PREFIX",lateArrival:"NEXT_AVAILABLE_SLOT",overflow:"BACKLOG_NEXT_DAY"}
};}

test("runtime planner persists plan and carries explicit next-day backlog",async()=>{
  const root=mkdtempSync(join(tmpdir(),"flerdvision-runtime-planner-"));
  const runtime=new SqliteDistributionRuntimeStateStore(join(root,"state.sqlite"));
  runtime.putAsset(asset("a1","01.mp4","2026-08-27"),"2026-08-27T06:10:00.000Z");
  runtime.putAsset(asset("a2","02.mp4","2026-08-27"),"2026-08-27T06:10:00.000Z");
  const adapter=new PersistedDistributionPlannerAdapter({load(){return config();},save(){throw new Error("read only");}},runtime);
  const day1=await adapter.ensureDailyPlan("2026-08-27","2026-08-27T06:15:00.000Z");
  assert.equal(day1.deliveries.length,1);
  assert.equal(day1.backlog.length,1);
  assert.equal(day1.backlog[0].carryToBusinessDate,"2026-08-28");
  assert.equal(runtime.latestDailyPlan("2026-08-27").plan.planId,day1.planId);

  const day2=await adapter.ensureDailyPlan("2026-08-28","2026-08-28T06:15:00.000Z");
  assert.equal(day2.deliveries.length,1);
  assert.equal(day2.deliveries[0].assetId,"a2");
  assert.equal(runtime.latestDailyPlan("2026-08-28").plan.planId,day2.planId);
  runtime.close();
});
