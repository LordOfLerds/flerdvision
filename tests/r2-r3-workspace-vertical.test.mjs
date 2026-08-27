import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { initializeWorkspaceRuntime } from "../dist/application/workspaces.js";
import { JsonDistributionConfigurationStore } from "../dist/adapters/distribution/json-config-store.js";
import { WorkspaceDistributionRuntime } from "../dist/adapters/runtime/workspace-distribution-runtime.js";

function sourceConfig(sourceRoot){return{
  sources:[{connectionId:"local",displayName:"Demo source",kind:"local_folder",rootRef:sourceRoot,enabled:true,disposition:{mode:"database_only",leavePartialUntouched:true,leaveBlockedUntouched:true}}],
  lanes:[{laneId:"creator-lane",connectionId:"local",displayName:"Creator lane",creatorId:"creator-1",folderRef:"creator",folderPath:"Creator",interpretation:{kind:"creator_week_day",weekStartBySegment:{KW35:"2026-08-24"}},enabled:true}],
  activationCursors:[{laneId:"creator-lane",mode:"IMPORT_BACKLOG",activatedAt:"2026-08-27T05:00:00.000Z"}],
  postingProfiles:[{postingProfileId:"ig-normal",displayName:"IG Normal",platform:"instagram",format:"reel",commentsEnabled:true,shareToFeed:true,crosspostFacebook:false,enabled:true}],
  copyProfiles:[{copyProfileId:"copy",displayName:"Copy",versionId:"v1",strategy:"static",enabled:true}],
  routes:[{routeId:"route-ig",displayName:"Creator IG",laneId:"creator-lane",accountId:"ig-test",platform:"instagram",postingProfileId:"ig-normal",copyProfileId:"copy",schedulePolicyId:"default",requirement:"REQUIRED",enabled:true}]
};}

test("workspace source flows forward to SCHEDULED intent and traces back to local source observation",async()=>{
  const root=mkdtempSync(join(tmpdir(),"flerdvision-vertical-"));
  const runtimeRoot=join(root,"runtime");
  const sourceRoot=join(root,"source");
  const dayDir=join(sourceRoot,"creator","KW35","04_Donnerstag");
  mkdirSync(dayDir,{recursive:true});
  writeFileSync(join(dayDir,"01.mp4"),Buffer.from("synthetic-media-bytes"));

  const ffprobe=join(root,"fake-ffprobe.sh");
  writeFileSync(ffprobe,"#!/bin/sh\necho '{\"format\":{\"duration\":\"1.0\",\"format_name\":\"mov,mp4\"},\"streams\":[{\"codec_type\":\"video\",\"codec_name\":\"h264\"}]}'\n");
  chmodSync(ffprobe,0o755);

  const layout=initializeWorkspaceRuntime(runtimeRoot,"vertical");
  const store=new JsonDistributionConfigurationStore(join(layout.configDir,"distribution.json"));
  const initial=store.load();
  store.save({...initial,config:sourceConfig(sourceRoot),updatedAt:"2026-08-27T05:00:00.000Z"},initial.revision);

  const runtime=new WorkspaceDistributionRuntime({runtimeRoot,workspaceId:"vertical",env:{...process.env,FFPROBE_EXECUTABLE_PATH:ffprobe}});
  try{
    const first=await runtime.source.scan("2026-08-27T06:00:00.000Z");
    assert.equal(first.stabilizing,1);
    assert.equal(runtime.state.listAssets()[0].asset.state,"STABILIZING");

    const second=await runtime.source.scan("2026-08-27T06:01:00.000Z");
    assert.equal(second.ready,1);
    const asset=runtime.state.listAssets()[0].asset;
    assert.equal(asset.state,"READY");
    assert.equal(asset.creatorId,"creator-1");
    assert.equal(asset.scheduledBusinessDate,"2026-08-27");

    const plan=await runtime.planner.ensureDailyPlan("2026-08-27","2026-08-27T06:02:00.000Z");
    assert.equal(plan.deliveries.length,1);
    assert.equal(plan.deliveries[0].assetId,asset.assetId);
    const materialized=await runtime.intents.ensureIntents(plan,"2026-08-27T06:03:00.000Z");
    assert.equal(materialized.created,1);
    assert.equal(materialized.blocked,0);

    const envelope=runtime.provenance.getIntentByDelivery(plan.deliveries[0].deliveryId);
    assert.ok(envelope);
    const intent=runtime.control.getIntent(envelope.envelope.intent.intentId);
    assert.equal(intent.state,"SCHEDULED");
    assert.ok(runtime.control.getReservationForIntent(intent.intent.intentId));

    const sourceObservation=runtime.control.getSourceObservation(asset.sourceObservationId);
    assert.ok(sourceObservation);
    assert.ok(sourceObservation.observation.locator.startsWith("file://"));
    assert.equal(sourceObservation.observation.metadata.laneId,"creator-lane");
  }finally{runtime.close();}
});
