import test from "node:test";
import assert from "node:assert/strict";
import { WorkspaceQualificationSyncService } from "../dist/application/workspace-qualification-sync.js";

const run={runId:"run:luca",releaseSha:"release-123",stage:"LUCA_MAC",workspaceId:"luca",hostFingerprint:"mac",createdAt:"2026-08-27T08:00:00.000Z",createdBy:"tester",status:"ACTIVE"};
const routes=[
  {routeId:"ig-route",displayName:"IG",laneId:"lane-main",accountId:"ig",platform:"instagram",postingProfileId:"ig-normal",copyProfileId:"copy",schedulePolicyId:"default",requirement:"REQUIRED",enabled:true},
  {routeId:"tt-route",displayName:"TT",laneId:"lane-main",accountId:"tt",platform:"tiktok",postingProfileId:"tt-public",copyProfileId:"copy",schedulePolicyId:"default",requirement:"REQUIRED",enabled:true}
];
function stored(){return{revision:1,updatedAt:"2026-08-27T08:00:00.000Z",config:{sources:[{connectionId:"source",displayName:"Drive",kind:"google_drive",rootRef:"root",enabled:true,disposition:{mode:"database_only",leavePartialUntouched:true,leaveBlockedUntouched:true}}],lanes:[{laneId:"lane-main",connectionId:"source",displayName:"Main",folderRef:"folder",folderPath:"/Main",interpretation:{kind:"flat"},enabled:true}],postingProfiles:[],copyProfiles:[],routes,activationCursors:[]},schedulePolicies:{},planningPolicy:{contentOrder:"FILENAME_NUMERIC_PREFIX",lateArrival:"NEXT_AVAILABLE_SLOT",overflow:"BACKLOG_NEXT_DAY"},runtimePolicy:{readiness:{timeZone:"Europe/Vienna",morningSummaryLocalTime:"08:00",preSlotWarningMinutes:45,preSlotEscalationMinutes:15,completionSummaryLocalTime:"18:00",quietOnNormalSuccess:true},sourcePolling:{timeZone:"Europe/Vienna",activeWindowStartLocal:"06:00",activeWindowEndLocal:"19:00",activeIntervalMinutes:5,idleIntervalMinutes:30,pollImmediatelyOnStartup:true},mediaCache:{retentionHoursAfterComplete:24}}};}
function routeTest(routeId,releaseSha="release-123",extra={}){return{routeId,sourcePassed:true,sessionPassed:true,identityPassed:true,prepareOnlyPasses:3,secretLivePassed:false,verificationPassed:true,cleanupPassed:false,releaseSha,surfaceContractId:`surface-${routeId}`,...extra};}
function snapshot(overrides={}){return{
  plan:{planId:"plan",businessDate:"2026-08-27",generatedAt:"2026-08-27T08:05:00.000Z",deliveries:[],gaps:[],backlog:[]},
  accounts:[{accountId:"ig",platform:"instagram",expectedHandle:"ig",enabled:true},{accountId:"tt",platform:"tiktok",expectedHandle:"tt",enabled:true}],
  channelReadiness:[{accountId:"ig",sessionHealth:"HEALTHY",identityVerified:true},{accountId:"tt",sessionHealth:"HEALTHY",identityVerified:true}],
  surfaceReadiness:[{accountId:"ig",postingProfileId:"ig-normal",surfaceContract:"CALIBRATED",contractId:"surface-ig-route"},{accountId:"tt",postingProfileId:"tt-public",surfaceContract:"CALIBRATED",contractId:"surface-tt-route"}],
  routeTests:[routeTest("ig-route"),routeTest("tt-route")],
  assets:[{assetId:"asset",contentId:"content",laneId:"lane-main",creatorId:"creator",sourceObservationId:"obs",sourceRef:"gdrive://file/a",externalObjectId:"a",filename:"01.mp4",mediaFingerprint:"fp",observedAt:"2026-08-27T08:01:00.000Z",state:"READY",metadata:{}}],
  sourceActivation:[{laneId:"lane-main",mode:"NEW_ONLY",state:"CAPTURED",baselineCount:2,capturedAt:"2026-08-27T08:00:30.000Z"}],
  sourcePolling:{lastPollAt:"2026-08-27T08:02:00.000Z",nextPollAt:"2026-08-27T08:07:00.000Z",lastTrigger:"INTERVAL",skippedCycles:0,updatedAt:"2026-08-27T08:02:00.000Z"},
  legacySourceBindings:{total:0,migrated:0,needsMigration:0,disabled:0,items:[]},
  ...overrides
};}
function harness(runtimeSnapshot=snapshot(),fresh=["ig","tt"]){
  const gates=[];
  const store={
    getRun(id){return id===run.runId?run:null;},
    listGates(){return gates;},
    appendGate(gate){gates.push(gate);return gate;},
    updateRunStatus(){throw new Error("not used");},
    createRun(){throw new Error("not used");},
    listRuns(){return[run];}
  };
  const config={load:()=>stored()};
  const runtime={async snapshot(){return runtimeSnapshot;}};
  const service=new WorkspaceQualificationSyncService(store,config,runtime,()=>fresh,"luca");
  return{service,gates};
}

test("sync records only gates proven by current durable workspace evidence",async()=>{
  const h=harness(),report=await h.service.sync(run.runId,"2026-08-27T08:10:00.000Z","sync");
  for(const gate of ["SOURCE_WORKFLOW","PROGRAM_ROUTING","BROWSER_IDENTITY","ROUTE_QUALIFICATION","INSTAGRAM_PREPARE","TIKTOK_PREPARE"])assert.ok(report.recordedGates.includes(gate),`${gate} should be derived`);
  assert.equal(report.recordedGates.includes("SECRET_E2E"),false);
  assert.equal(report.recordedGates.includes("PRODUCT_CONTROL_CENTER"),false,"non-derivable host behavior gate must remain manual/evidence-driven");
  assert.equal(h.gates.every(gate=>gate.artifactRefs.length>0),true);
});

test("old release route tests cannot qualify prepare or route execution",async()=>{
  const old=snapshot({routeTests:[routeTest("ig-route","old-release"),routeTest("tt-route","old-release")]});
  const report=await harness(old).service.sync(run.runId,"2026-08-27T08:10:00.000Z","sync");
  for(const gate of ["ROUTE_QUALIFICATION","INSTAGRAM_PREPARE","TIKTOK_PREPARE","SECRET_E2E"])assert.equal(report.recordedGates.includes(gate),false,`${gate} must not use old release evidence`);
});

test("legacy migration gap blocks PROGRAM_ROUTING and stale host evidence blocks source/identity",async()=>{
  const stale=snapshot({
    sourcePolling:{lastPollAt:"2026-08-27T07:59:00.000Z",nextPollAt:"2026-08-27T08:04:00.000Z",lastTrigger:"INTERVAL",skippedCycles:0,updatedAt:"2026-08-27T07:59:00.000Z"},
    legacySourceBindings:{total:1,migrated:0,needsMigration:1,disabled:0,items:[{bindingId:"legacy",accountId:"ig",source:"google_drive",folderId:"folder",folderPath:"/Main",status:"NEEDS_MIGRATION",matchingLaneIds:["lane-main"],matchingRouteIds:[],reason:"missing route"}]}
  });
  const report=await harness(stale,[]).service.sync(run.runId,"2026-08-27T08:10:00.000Z","sync");
  assert.equal(report.recordedGates.includes("SOURCE_WORKFLOW"),false);
  assert.equal(report.recordedGates.includes("PROGRAM_ROUTING"),false);
  assert.equal(report.recordedGates.includes("BROWSER_IDENTITY"),false);
});

test("SECRET_E2E and VERIFICATION_CLEANUP require both Instagram and TikTok on the exact release",async()=>{
  const igOnly=snapshot({routeTests:[routeTest("ig-route","release-123",{secretLivePassed:true,cleanupPassed:true}),routeTest("tt-route")]});
  let report=await harness(igOnly).service.sync(run.runId,"2026-08-27T08:10:00.000Z","sync");
  assert.equal(report.recordedGates.includes("SECRET_E2E"),false);
  assert.equal(report.recordedGates.includes("VERIFICATION_CLEANUP"),false);

  const both=snapshot({routeTests:[routeTest("ig-route","release-123",{secretLivePassed:true,cleanupPassed:true}),routeTest("tt-route","release-123",{secretLivePassed:true,cleanupPassed:true})]});
  report=await harness(both).service.sync(run.runId,"2026-08-27T08:10:00.000Z","sync");
  assert.ok(report.recordedGates.includes("SECRET_E2E"));
  assert.ok(report.recordedGates.includes("VERIFICATION_CLEANUP"));
});

test("sync refuses a qualification run belonging to another workspace",async()=>{
  const foreign={...run,workspaceId:"fabian"},gates=[];
  const store={getRun(){return foreign;},listGates(){return gates;},appendGate(g){gates.push(g);return g;},listRuns(){return[foreign];}};
  const service=new WorkspaceQualificationSyncService(store,{load:()=>stored()},{async snapshot(){return snapshot();}},()=>["ig","tt"],"luca");
  await assert.rejects(()=>service.sync(foreign.runId,"2026-08-27T08:10:00.000Z","sync"),/belongs to workspace fabian, not luca/);
});
