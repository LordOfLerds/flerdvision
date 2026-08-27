import test from "node:test";
import assert from "node:assert/strict";
import { DistributionDeliveryAggregateProjector } from "../dist/application/distribution-delivery-aggregate.js";
import { RuntimeDistributionDispositionAdapter } from "../dist/application/runtime-distribution-disposition.js";
import { ConfiguredDistributionDispositionExecutor } from "../dist/adapters/disposition/distribution-executor.js";

function delivery(id,requirement){return{deliveryId:id,routeId:"route",assetId:"asset",contentId:"content",creatorId:"creator",laneId:"lane",accountId:"account",platform:"instagram",format:"reel",postingProfileId:"ig",copyProfileId:"copy",copyVersionId:"v1",schedulePolicyId:"default",requirement,businessDate:"2026-08-27",slotKey:id,scheduledFor:id==="required"?"2026-08-27T07:00:00.000Z":"2026-08-27T09:00:00.000Z",windowStartAt:"2026-08-27T06:30:00.000Z",windowEndAt:"2026-08-27T09:30:00.000Z"};}
const required=delivery("required","REQUIRED");
const optional=delivery("optional","OPTIONAL");

function envelope(delivery,intentId){return{envelope:{intent:{intentId,contentId:"content",creatorId:"creator",platform:"instagram",accountId:"account",format:"reel",copyVersionId:"v1",scheduledFor:delivery.scheduledFor,idempotencyKey:`key-${intentId}`},provenance:{planId:"plan",deliveryId:delivery.deliveryId,routeId:"route",laneId:"lane",assetId:"asset",postingProfileId:"ig",copyProfileId:"copy",schedulePolicyId:"default",routeSnapshotFingerprint:"fp",postingProfileSnapshot:{postingProfileId:"ig",displayName:"IG",platform:"instagram",format:"reel",commentsEnabled:true,shareToFeed:true,crosspostFacebook:false,enabled:true}}},createdAt:"2026-08-27T06:00:00.000Z"};}

test("aggregate uses current plan heads and optional failure does not block complete",()=>{
  const runtime={
    listCurrentDailyPlans(){return[{plan:{planId:"current",businessDate:"2026-08-27",generatedAt:"2026-08-27T06:00:00.000Z",deliveries:[required,optional],gaps:[],backlog:[]},recordedAt:"2026-08-27T06:00:00.000Z"}];},
    listDailyPlans(){throw new Error("audit history must not be read by aggregate projector");}
  };
  const provenance={getIntentByDelivery(id){return id==="required"?envelope(required,"intent-required"):envelope(optional,"intent-optional");}};
  const intents={getIntent(id){return{id, intent:provenance.getIntentByDelivery(id==="intent-required"?"required":"optional").envelope.intent,state:id==="intent-required"?"VERIFIED":"BLOCKED",createdAt:"2026-08-27T06:00:00.000Z",updatedAt:"2026-08-27T06:00:00.000Z"};}};
  const verification={getVerifiedPublication(id){return id==="intent-required"?{publicationId:"publication:req",intentId:id,verifiedAt:"2026-08-27T10:00:00.000Z",evidenceIds:["e1"]}:null;}};
  const result=new DistributionDeliveryAggregateProjector(runtime,provenance,intents,verification).project("asset")[0];
  assert.equal(result.aggregate.status,"COMPLETE");
  assert.deepEqual(result.aggregate.verifiedDeliveryIds,["required"]);
  assert.deepEqual(result.aggregate.failedDeliveryIds,["optional"]);
  assert.deepEqual(result.publicationIds,["publication:req"]);
});

test("runtime disposition marks asset COMPLETE only after explicit executor success",async()=>{
  let asset={assetId:"asset",contentId:"content",laneId:"lane",creatorId:"creator",sourceObservationId:"obs",sourceRef:"gdrive://file/x",externalObjectId:"x",filename:"x.mp4",mediaFingerprint:"fp",observedAt:"2026-08-27T06:00:00.000Z",state:"READY",readyAt:"2026-08-27T06:05:00.000Z",metadata:{}};
  const runtime={getAsset(){return{asset,version:1,recordedAt:"2026-08-27T06:05:00.000Z"};},putAsset(next){asset=next;return{created:true,record:{asset:next,version:2,recordedAt:"2026-08-27T11:00:00.000Z"}};}};
  const connection={connectionId:"src",displayName:"Drive",kind:"google_drive",rootRef:"root",enabled:true,disposition:{mode:"database_only",leavePartialUntouched:true,leaveBlockedUntouched:true}};
  const config={load(){return{config:{sources:[connection],lanes:[{laneId:"lane",connectionId:"src",displayName:"Lane",folderRef:"f",folderPath:"Lane",interpretation:{kind:"flat"},enabled:true}],postingProfiles:[],copyProfiles:[],routes:[],activationCursors:[]}};}};
  const aggregates={project(){return[{aggregate:{assetId:"asset",requiredDeliveryIds:["d"],optionalDeliveryIds:[],verifiedDeliveryIds:["d"],waivedDeliveryIds:[],failedDeliveryIds:[],status:"COMPLETE"},traces:[],publicationIds:["pub"]}];}};
  let execution;
  const executor={async execute(input){execution=input;return{applied:true,externalMutation:false,manualReview:false,summary:"recorded"};}};
  const report=await new RuntimeDistributionDispositionAdapter(config,runtime,aggregates,executor).applyEligible("2026-08-27T11:00:00.000Z");
  assert.equal(report.completed,1);
  assert.equal(asset.state,"COMPLETE");
  assert.equal(asset.metadata.completedAt,"2026-08-27T11:00:00.000Z");
  assert.equal(execution.occurredAt,"2026-08-27T11:00:00.000Z");
});

test("external source mutation without explicit adapter stays manual review",async()=>{
  const executor=new ConfiguredDistributionDispositionExecutor({});
  const result=await executor.execute({mutation:"WRITE_SIDECAR",connection:{connectionId:"src",displayName:"Source",kind:"local_folder",rootRef:"/tmp",enabled:true,disposition:{mode:"sidecar",leavePartialUntouched:true,leaveBlockedUntouched:true}},sourceObservationId:"obs",publicationIds:["pub"],occurredAt:"2026-08-27T11:00:00.000Z",policy:{mode:"sidecar",leavePartialUntouched:true,leaveBlockedUntouched:true}});
  assert.equal(result.applied,false);
  assert.equal(result.manualReview,true);
  assert.equal(result.externalMutation,false);
});
