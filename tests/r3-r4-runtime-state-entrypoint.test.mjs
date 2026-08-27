import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqliteDistributionRuntimeStateStore, DistributionRuntimeConflictError } from "../dist/adapters/distribution/sqlite-runtime-state.js";
import { SqliteControlCenterRuntimeAdapter } from "../dist/adapters/control/sqlite-control-center-runtime.js";
import { SqliteControlPlaneStore } from "../dist/adapters/storage/sqlite.js";
import { SqlitePlatformSurfaceStore } from "../dist/adapters/distribution/sqlite-surface-store.js";
import { JsonDistributionConfigurationStore } from "../dist/adapters/distribution/json-config-store.js";
import { DistributionManagementService } from "../dist/application/distribution-management.js";

function workspace(){
  const root=mkdtempSync(join(tmpdir(),"flerdvision-runtime-state-"));
  return{root,db:join(root,"flerdvision.sqlite"),config:join(root,"distribution.json")};
}
function plan(generatedAt="2026-08-27T06:00:00.000Z"){
  return{planId:"daily-plan:semantic",businessDate:"2026-08-27",generatedAt,deliveries:[],gaps:[],backlog:[]};
}
function asset(state="OBSERVED"){
  return{assetId:"asset-1",contentId:"content-1",laneId:"lane",creatorId:"creator",sourceObservationId:"observation-1",sourceRef:"source-ref",externalObjectId:"file-1",filename:"01.mp4",mediaFingerprint:"sha",observedAt:"2026-08-27T05:00:00.000Z",state,...(state==="READY"?{readyAt:"2026-08-27T05:01:00.000Z"}:{}),scheduledBusinessDate:"2026-08-27",metadata:{}};
}

test("runtime state keeps plan revisions append-only and accepts same semantic plan at a later generation time",()=>{
  const paths=workspace();const store=new SqliteDistributionRuntimeStateStore(paths.db);
  const first=store.putDailyPlan(plan(),"2026-08-27T06:00:01.000Z");
  const second=store.putDailyPlan(plan("2026-08-27T07:00:00.000Z"),"2026-08-27T07:00:01.000Z");
  assert.equal(first.created,true);assert.equal(second.created,false);
  assert.equal(store.listDailyPlans("2026-08-27").length,1);
  assert.equal(store.latestDailyPlan("2026-08-27").plan.planId,"daily-plan:semantic");
  store.close();
});

test("asset runtime state versions legal transitions and rejects immutable/source mutation",()=>{
  const paths=workspace();const store=new SqliteDistributionRuntimeStateStore(paths.db);
  assert.equal(store.putAsset(asset(),"2026-08-27T05:00:01.000Z").record.version,1);
  assert.equal(store.putAsset(asset("READY"),"2026-08-27T05:01:00.000Z").record.version,2);
  assert.throws(()=>store.putAsset({...asset("READY"),filename:"different.mp4"},"2026-08-27T05:02:00.000Z"),DistributionRuntimeConflictError);
  store.putAsset(asset("COMPLETE"),"2026-08-27T06:00:00.000Z");
  assert.throws(()=>store.putAsset(asset("READY"),"2026-08-27T06:01:00.000Z"),/cannot transition/);
  store.close();
});

test("Control Center runtime adapter joins real account health, profile surface, plan, asset and route-test state",async()=>{
  const paths=workspace();const config=new JsonDistributionConfigurationStore(paths.config);const management=new DistributionManagementService(config);let rev=0;
  rev=management.saveSource({connectionId:"source",displayName:"Drive",kind:"local_folder",rootRef:"root",enabled:true,disposition:{mode:"database_only",leavePartialUntouched:true,leaveBlockedUntouched:true}},rev,"2026-08-27T04:00:00.000Z").stored.revision;
  rev=management.saveLane({laneId:"lane",connectionId:"source",displayName:"Lane",folderRef:"folder",folderPath:"Lane",interpretation:{kind:"flat"},enabled:true},rev,"2026-08-27T04:01:00.000Z").stored.revision;
  rev=management.saveActivationCursor({laneId:"lane",mode:"NEW_ONLY",activatedAt:"2026-08-27T04:00:00.000Z"},rev,"2026-08-27T04:02:00.000Z").stored.revision;
  rev=management.savePostingProfile({postingProfileId:"ig",displayName:"IG Normal",platform:"instagram",format:"reel",commentsEnabled:true,shareToFeed:true,crosspostFacebook:false,enabled:true},rev,"2026-08-27T04:03:00.000Z").stored.revision;
  rev=management.saveCopyProfile({copyProfileId:"copy",displayName:"Copy",versionId:"v1",strategy:"template",enabled:true},rev,"2026-08-27T04:04:00.000Z").stored.revision;
  management.saveRoute({routeId:"route",displayName:"Route",laneId:"lane",accountId:"account",platform:"instagram",postingProfileId:"ig",copyProfileId:"copy",schedulePolicyId:"default",requirement:"REQUIRED",enabled:true},rev,"2026-08-27T04:05:00.000Z");

  const control=new SqliteControlPlaneStore(paths.db);const actor={type:"test",id:"runtime-test"};
  control.registerSocialAccount({accountId:"account",platform:"instagram",expectedHandle:"example",enabled:true},"2026-08-27T04:00:00.000Z",actor);
  control.registerBrowserIdentity({identityId:"identity",accountId:"account",platform:"instagram",profileKey:"instagram/example",expectedHandle:"example",enabled:true},"2026-08-27T04:00:00.000Z",actor);
  control.recordSessionHealth({checkId:"health",identityId:"identity",checkedAt:"2026-08-27T05:00:00.000Z",state:"HEALTHY",expectedHandle:"example",observedHandle:"example"},actor);
  control.close();

  const runtimeState=new SqliteDistributionRuntimeStateStore(paths.db);
  runtimeState.putDailyPlan(plan(),"2026-08-27T06:00:01.000Z");
  runtimeState.putAsset(asset("READY"),"2026-08-27T05:01:00.000Z");
  runtimeState.putRouteTestReadiness({routeId:"route",sourcePassed:true,sessionPassed:true,identityPassed:true,prepareOnlyPasses:3,secretLivePassed:false,verificationPassed:true,cleanupPassed:false,releaseSha:"sha",surfaceContractId:"contract"},"2026-08-27T06:10:00.000Z");
  runtimeState.close();

  const surfaces=new SqlitePlatformSurfaceStore(paths.db);
  surfaces.recordContract({contractId:"contract",accountId:"account",platform:"instagram",format:"reel",postingProfileId:"ig",environment:{browserFamily:"chromium",browserMajor:140,language:"de-AT",timeZone:"Europe/Vienna",viewportWidth:1280,viewportHeight:900,deviceScaleFactor:1,fingerprint:"env"},steps:[],status:"CALIBRATED",createdAt:"2026-08-27T05:30:00.000Z",calibratedAt:"2026-08-27T05:30:00.000Z"},"2026-08-27T05:30:00.000Z");
  surfaces.close();

  const adapter=new SqliteControlCenterRuntimeAdapter(paths.db,config);const snapshot=await adapter.snapshot("2026-08-27");
  assert.equal(snapshot.plan.planId,"daily-plan:semantic");
  assert.equal(snapshot.accounts[0].accountId,"account");
  assert.equal(snapshot.channelReadiness[0].sessionHealth,"HEALTHY");
  assert.equal(snapshot.surfaceReadiness[0].postingProfileId,"ig");
  assert.equal(snapshot.surfaceReadiness[0].surfaceContract,"CALIBRATED");
  assert.equal(snapshot.routeTests[0].prepareOnlyPasses,3);
  assert.equal(snapshot.assets[0].state,"READY");
  adapter.close();
});
