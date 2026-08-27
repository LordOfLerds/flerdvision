import test from "node:test";
import assert from "node:assert/strict";
import { activationDecision, SourceActivationService, sourceActivationCursorFingerprint } from "../dist/application/source-activation.js";

const lane={laneId:"lane-a",connectionId:"src",displayName:"A",folderRef:"folder",folderPath:"A",interpretation:{kind:"flat"},enabled:true};
const source={connectionId:"src",displayName:"Drive",kind:"google_drive",rootRef:"root",enabled:true,disposition:{mode:"database_only",leavePartialUntouched:true,leaveBlockedUntouched:true}};
function observation(id,modifiedTime="2026-08-27T08:00:00.000Z"){
  return{observationId:`obs-${id}`,sourceId:"lane:lane-a",externalObjectId:id,observedAt:"2026-08-27T08:30:00.000Z",locator:`gdrive://file/${id}`,mediaFingerprint:`fp-${id}`,metadata:{modifiedTime}};
}

test("NEW_ONLY requires a captured baseline and excludes files that existed at activation", async()=>{
  const cursor={laneId:"lane-a",mode:"NEW_ONLY",activatedAt:"2026-08-27T08:00:00.000Z"};
  const stored=new Map();
  const baselines={
    getBaseline(laneId,fingerprint){return stored.get(`${laneId}|${fingerprint}`)??null;},
    putBaseline(baseline,now){const record={baseline,createdAt:now};stored.set(`${baseline.laneId}|${baseline.cursorFingerprint}`,record);return{created:true,record};}
  };
  const service=new SourceActivationService({async observeLane(){return[observation("old-1"),observation("old-2")];}},baselines);
  assert.deepEqual(activationDecision(cursor,null,observation("old-1")),{eligible:false,reason:"BASELINE_EXISTING"});
  const baseline=await service.ensureBaseline(source,lane,cursor,"2026-08-27T08:00:00.000Z");
  assert.deepEqual(baseline.externalObjectIds,["old-1","old-2"]);
  assert.equal(baseline.cursorFingerprint,sourceActivationCursorFingerprint(cursor));
  assert.equal(activationDecision(cursor,baseline,observation("old-1")).eligible,false);
  assert.deepEqual(activationDecision(cursor,baseline,observation("new-3")),{eligible:true,reason:"NEW_AFTER_BASELINE"});
});

test("SINCE fails closed when provider time is unavailable and prefers createdTime over later edits",()=>{
  const cursor={laneId:"lane-a",mode:"SINCE",activatedAt:"2026-08-27T08:00:00.000Z",since:"2026-08-27T08:00:00.000Z"};
  const missing={...observation("x"),metadata:{}};
  assert.deepEqual(activationDecision(cursor,null,missing),{eligible:false,reason:"MISSING_TIMESTAMP"});
  assert.equal(activationDecision(cursor,null,observation("old","2026-08-27T07:59:59.000Z")).eligible,false);
  assert.equal(activationDecision(cursor,null,observation("new","2026-08-27T08:00:00.000Z")).eligible,true);
  const oldCreatedButEditedLater={...observation("edited","2026-08-27T09:00:00.000Z"),metadata:{createdTime:"2026-08-26T09:00:00.000Z",modifiedTime:"2026-08-27T09:00:00.000Z"}};
  assert.equal(activationDecision(cursor,null,oldCreatedButEditedLater).eligible,false);
});

test("SELECTED and IMPORT_BACKLOG are explicit and deterministic",()=>{
  const selected={laneId:"lane-a",mode:"SELECTED",activatedAt:"2026-08-27T08:00:00.000Z",selectedExternalObjectIds:["a"]};
  assert.equal(activationDecision(selected,null,observation("a")).eligible,true);
  assert.equal(activationDecision(selected,null,observation("b")).eligible,false);
  const backlog={laneId:"lane-a",mode:"IMPORT_BACKLOG",activatedAt:"2026-08-27T08:00:00.000Z"};
  assert.equal(activationDecision(backlog,null,observation("anything")).eligible,true);
});
