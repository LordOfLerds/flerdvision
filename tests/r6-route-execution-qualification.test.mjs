import test from "node:test";
import assert from "node:assert/strict";
import { PersistedRouteExecutionQualificationGate } from "../dist/application/route-execution-qualification.js";

const FINGERPRINT = "surface-fingerprint-current";
function delivery(){return{deliveryId:"d1",routeId:"route",assetId:"a1",contentId:"c1",creatorId:"creator",laneId:"lane",accountId:"ig",platform:"instagram",format:"reel",postingProfileId:"profile",copyProfileId:"copy",copyVersionId:"v1",schedulePolicyId:"schedule",requirement:"REQUIRED",businessDate:"2026-08-27",slotKey:"slot-1",scheduledFor:"2026-08-27T07:00:00.000Z",windowStartAt:"2026-08-27T06:30:00.000Z",windowEndAt:"2026-08-27T07:30:00.000Z"};}
function config(){return{revision:1,updatedAt:"2026-08-27T06:00:00.000Z",config:{sources:[],lanes:[],activationCursors:[],copyProfiles:[],postingProfiles:[],routes:[{routeId:"route",displayName:"Route",laneId:"lane",accountId:"ig",platform:"instagram",postingProfileId:"profile",copyProfileId:"copy",schedulePolicyId:"schedule",requirement:"REQUIRED",enabled:true}]},schedulePolicies:{},planningPolicy:{contentOrder:"OBSERVED_AT",lateArrival:"NEXT_AVAILABLE_SLOT",overflow:"BACKLOG_NEXT_DAY"}};}
function readiness(overrides={}){return{routeId:"route",sourcePassed:true,sessionPassed:true,identityPassed:true,prepareOnlyPasses:1,secretLivePassed:false,verificationPassed:true,cleanupPassed:false,releaseSha:"sha-1",surfaceFingerprint:FINGERPRINT,surfaceContractId:"surface-1",...overrides};}
function runtime(value){return{latestRouteTestReadiness(){return value?{readiness:value,version:1,recordedAt:"2026-08-27T06:00:00.000Z"}:null;}};}
function surfaces(status="CALIBRATED"){return{latestContract(){return{versionId:"v1",recordedAt:"2026-08-27T06:00:00.000Z",contract:{contractId:"surface-1",accountId:"ig",postingProfileId:"profile",platform:"instagram",format:"reel",status,environment:{fingerprint:"env"},steps:[]}};}};}
function gate(value,status="CALIBRATED",options={surfaceFingerprint:FINGERPRINT}){return new PersistedRouteExecutionQualificationGate({load:config},runtime(value),surfaces(status),"sha-1",options);}

test("missing route qualification blocks materialization",()=>{
  const result=gate(null).evaluate(delivery());
  assert.equal(result.allowed,false);
  assert.ok(result.reasons.includes("route_test_readiness_missing"));
});

test("route qualification is bound to the surface fingerprint and current calibrated surface",()=>{
  assert.equal(gate(readiness()).evaluate(delivery()).allowed,true);
  const staleSurface=gate(readiness({surfaceFingerprint:"surface-fingerprint-old"}));
  assert.ok(staleSurface.evaluate(delivery()).reasons.includes("surface_fingerprint_stale"));
  const withoutFingerprint=gate(readiness({surfaceFingerprint:undefined}));
  assert.ok(withoutFingerprint.evaluate(delivery()).reasons.includes("surface_fingerprint_stale"),"pre-fingerprint evidence cannot prove which surface code it ran against");
  assert.ok(gate(readiness(),"RECORDED").evaluate(delivery()).reasons.includes("surface_contract_not_calibrated"));
});

test("a release SHA mismatch alone no longer blocks a qualified route",()=>{
  const decision=gate(readiness({releaseSha:"old-release"})).evaluate(delivery());
  assert.equal(decision.allowed,true,"a commit that cannot change the surface must not requalify the route");
  assert.equal(decision.reasons.length,0);
  const audit=gate(readiness({releaseSha:"old-release"})).qualifiedReleaseSha("route");
  assert.equal(audit.recorded,"old-release");
  assert.equal(audit.current,"sha-1");
  assert.equal(audit.matches,false);
});

test("the required prepare-only replay count follows the configured setting",()=>{
  assert.equal(gate(readiness({prepareOnlyPasses:1})).evaluate(delivery()).allowed,true);
  const stricter=new PersistedRouteExecutionQualificationGate({load:config},runtime(readiness({prepareOnlyPasses:1})),surfaces(),"sha-1",{surfaceFingerprint:FINGERPRINT,replays:3});
  assert.ok(stricter.evaluate(delivery()).reasons.includes("prepare_only_replays_missing"));
  assert.equal(gate(readiness({prepareOnlyPasses:0})).evaluate(delivery()).reasons.includes("prepare_only_replays_missing"),true);
});
