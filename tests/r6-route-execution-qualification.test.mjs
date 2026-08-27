import test from "node:test";
import assert from "node:assert/strict";
import { PersistedRouteExecutionQualificationGate } from "../dist/application/route-execution-qualification.js";

function delivery(){return{deliveryId:"d1",routeId:"route",assetId:"a1",contentId:"c1",creatorId:"creator",laneId:"lane",accountId:"ig",platform:"instagram",format:"reel",postingProfileId:"profile",copyProfileId:"copy",copyVersionId:"v1",schedulePolicyId:"schedule",requirement:"REQUIRED",businessDate:"2026-08-27",slotKey:"slot-1",scheduledFor:"2026-08-27T07:00:00.000Z",windowStartAt:"2026-08-27T06:30:00.000Z",windowEndAt:"2026-08-27T07:30:00.000Z"};}
function config(){return{revision:1,updatedAt:"2026-08-27T06:00:00.000Z",config:{sources:[],lanes:[],activationCursors:[],copyProfiles:[],postingProfiles:[],routes:[{routeId:"route",displayName:"Route",laneId:"lane",accountId:"ig",platform:"instagram",postingProfileId:"profile",copyProfileId:"copy",schedulePolicyId:"schedule",requirement:"REQUIRED",enabled:true}]},schedulePolicies:{},planningPolicy:{contentOrder:"OBSERVED_AT",lateArrival:"NEXT_AVAILABLE_SLOT",overflow:"BACKLOG_NEXT_DAY"}};}
function readiness(overrides={}){return{routeId:"route",sourcePassed:true,sessionPassed:true,identityPassed:true,prepareOnlyPasses:3,secretLivePassed:false,verificationPassed:true,cleanupPassed:false,releaseSha:"sha-1",surfaceContractId:"surface-1",...overrides};}
function runtime(value){return{latestRouteTestReadiness(){return value?{readiness:value,version:1,recordedAt:"2026-08-27T06:00:00.000Z"}:null;}};}
function surfaces(status="CALIBRATED"){return{latestContract(){return{versionId:"v1",recordedAt:"2026-08-27T06:00:00.000Z",contract:{contractId:"surface-1",accountId:"ig",postingProfileId:"profile",platform:"instagram",format:"reel",status,environment:{fingerprint:"env"},steps:[]}};}};}

test("missing route qualification blocks materialization",()=>{
  const gate=new PersistedRouteExecutionQualificationGate({load:config},runtime(null),surfaces(),"sha-1");
  const result=gate.evaluate(delivery());
  assert.equal(result.allowed,false);
  assert.ok(result.reasons.includes("route_test_readiness_missing"));
});

test("route qualification is bound to release and current calibrated surface",()=>{
  const good=new PersistedRouteExecutionQualificationGate({load:config},runtime(readiness()),surfaces(),"sha-1");
  assert.equal(good.evaluate(delivery()).allowed,true);
  const staleRelease=new PersistedRouteExecutionQualificationGate({load:config},runtime(readiness({releaseSha:"old"})),surfaces(),"sha-1");
  assert.ok(staleRelease.evaluate(delivery()).reasons.includes("route_test_release_sha_stale_or_missing"));
  const drifted=new PersistedRouteExecutionQualificationGate({load:config},runtime(readiness()),surfaces("RECORDED"),"sha-1");
  assert.ok(drifted.evaluate(delivery()).reasons.includes("surface_contract_not_calibrated"));
});
