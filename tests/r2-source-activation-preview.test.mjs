import test from "node:test";
import assert from "node:assert/strict";
import { SourceActivationCommandService } from "../dist/application/source-activation-command.js";

const source={connectionId:"src",displayName:"Drive",kind:"google_drive",rootRef:"root",enabled:true,disposition:{mode:"database_only",leavePartialUntouched:true,leaveBlockedUntouched:true}};
const lane={laneId:"lane",connectionId:"src",displayName:"Lane",folderRef:"folder",folderPath:"/Lane",interpretation:{kind:"flat"},enabled:true};
const cursor={laneId:"lane",mode:"NEW_ONLY",activatedAt:"2026-08-27T08:00:00.000Z"};
function observation(id,name){return{observationId:`obs-${id}`,sourceId:"lane:lane",externalObjectId:id,observedAt:"2026-08-27T08:00:00.000Z",locator:`gdrive://file/${id}`,mediaFingerprint:`fp-${id}`,metadata:{fileName:name}};}

function fixture(){
  let observed=[observation("old-1","01.mp4"),observation("old-2","02.mp4")];
  const baselineMap=new Map();
  const baselines={
    getBaseline(laneId,fingerprint){return baselineMap.get(`${laneId}|${fingerprint}`)??null;},
    putBaseline(baseline,now){const record={baseline,createdAt:now};baselineMap.set(`${baseline.laneId}|${baseline.cursorFingerprint}`,record);return{created:true,record};}
  };
  const config={load(){return{revision:0,updatedAt:"2026-08-27T08:00:00.000Z",config:{sources:[source],lanes:[lane],postingProfiles:[],copyProfiles:[],routes:[],activationCursors:[cursor]},schedulePolicies:{},planningPolicy:{contentOrder:"FILENAME_NUMERIC_PREFIX",lateArrival:"NEXT_AVAILABLE_SLOT",overflow:"BACKLOG_NEXT_DAY"}};}};
  const observations={async observeLane(){return observed;}};
  return{service:new SourceActivationCommandService(config,observations,baselines),setObserved(next){observed=next;}};
}

test("NEW_ONLY preview reports exact existing set and confirm rejects folder drift",async()=>{
  const f=fixture(),preview=await f.service.previewBaseline("lane","2026-08-27T08:00:00.000Z");
  assert.equal(preview.observedCount,2);
  assert.deepEqual(preview.sampleFileNames,["01.mp4","02.mp4"]);
  f.setObserved([observation("old-1","01.mp4"),observation("old-2","02.mp4"),observation("new-between","03.mp4")]);
  await assert.rejects(()=>f.service.captureBaseline("lane","2026-08-27T08:01:00.000Z",preview.snapshotFingerprint),/changed after baseline preview/);
});

test("NEW_ONLY confirm persists exactly the previewed set when source stayed unchanged",async()=>{
  const f=fixture(),preview=await f.service.previewBaseline("lane","2026-08-27T08:00:00.000Z");
  const status=await f.service.captureBaseline("lane","2026-08-27T08:01:00.000Z",preview.snapshotFingerprint);
  assert.equal(status.state,"CAPTURED");
  assert.equal(status.baselineCount,2);
  await assert.rejects(()=>f.service.previewBaseline("lane","2026-08-27T08:02:00.000Z"),/already has a captured/);
});
