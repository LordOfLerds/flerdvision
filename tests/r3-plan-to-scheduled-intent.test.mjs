import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqliteControlPlaneStore } from "../dist/adapters/storage/sqlite.js";
import { SqliteDistributionRuntimeStateStore } from "../dist/adapters/distribution/sqlite-runtime-state.js";
import { SqliteDistributionProvenanceStore } from "../dist/adapters/distribution/sqlite-provenance.js";
import { PersistedDistributionPlannerAdapter } from "../dist/application/runtime-source-planner-adapters.js";
import { DistributionIntentMaterializer, DistributionPlanProvenanceService } from "../dist/application/distribution-intent-materializer.js";
import { DEFAULT_SCHEDULING_POLICY } from "../dist/domain/scheduling.js";

function config(){return{
  revision:1,updatedAt:"2026-08-27T06:00:00.000Z",
  config:{
    sources:[{connectionId:"src",displayName:"Source",kind:"local_folder",rootRef:"/tmp",enabled:true,disposition:{mode:"database_only",leavePartialUntouched:true,leaveBlockedUntouched:true}}],
    lanes:[{laneId:"lane",connectionId:"src",displayName:"Lane",folderRef:"lane",folderPath:"lane",interpretation:{kind:"flat"},enabled:true}],
    activationCursors:[{laneId:"lane",mode:"IMPORT_BACKLOG",activatedAt:"2026-08-27T05:00:00.000Z"}],
    postingProfiles:[{postingProfileId:"ig",displayName:"IG",platform:"instagram",format:"reel",commentsEnabled:true,shareToFeed:true,crosspostFacebook:false,enabled:true}],
    copyProfiles:[{copyProfileId:"copy",displayName:"Copy",versionId:"v1",strategy:"static",enabled:true}],
    routes:[{routeId:"route",displayName:"Route",laneId:"lane",accountId:"ig-account",platform:"instagram",postingProfileId:"ig",copyProfileId:"copy",schedulePolicyId:"default",requirement:"REQUIRED",enabled:true}]
  },
  schedulePolicies:{default:DEFAULT_SCHEDULING_POLICY},
  planningPolicy:{contentOrder:"FILENAME_NUMERIC_PREFIX",lateArrival:"NEXT_AVAILABLE_SLOT",overflow:"BACKLOG_NEXT_DAY"}
};}
function asset(){return{assetId:"asset-1",contentId:"content-1",laneId:"lane",creatorId:"creator",sourceObservationId:"obs-1",sourceRef:"file:///tmp/01.mp4",externalObjectId:"01.mp4",filename:"01.mp4",mediaFingerprint:"fp-1",observedAt:"2026-08-27T06:00:00.000Z",state:"READY",readyAt:"2026-08-27T06:10:00.000Z",scheduledBusinessDate:"2026-08-27",metadata:{}};}

test("durable DailyPlan becomes one scheduled intent with matching immutable provenance",async()=>{
  const root=mkdtempSync(join(tmpdir(),"flerdvision-plan-intent-"));
  const db=join(root,"state.sqlite");
  const runtime=new SqliteDistributionRuntimeStateStore(db);
  const control=new SqliteControlPlaneStore(db);
  const provenance=new SqliteDistributionProvenanceStore(db);
  const configStore={load(){return config();},save(){throw new Error("read only");}};
  runtime.putAsset(asset(),"2026-08-27T06:10:00.000Z");

  const plan=await new PersistedDistributionPlannerAdapter(configStore,runtime)
    .ensureDailyPlan("2026-08-27","2026-08-27T06:15:00.000Z");
  assert.equal(plan.deliveries.length,1);
  new DistributionPlanProvenanceService(configStore,provenance).capture(plan,"2026-08-27T06:15:01.000Z");
  const report=new DistributionIntentMaterializer(control,configStore,provenance)
    .ensureIntents(plan,"2026-08-27T06:15:02.000Z");
  assert.deepEqual({created:report.created,existing:report.existing,blocked:report.blocked},{created:1,existing:0,blocked:0});

  const envelope=provenance.getIntentByDelivery(plan.deliveries[0].deliveryId);
  assert.ok(envelope);
  assert.equal(envelope.envelope.provenance.routeId,"route");
  assert.equal(envelope.envelope.provenance.postingProfileId,"ig");
  assert.equal(envelope.envelope.provenance.assetId,"asset-1");

  const intent=control.getIntent(envelope.envelope.intent.intentId);
  assert.equal(intent.state,"SCHEDULED");
  const reservation=control.getReservationForIntent(intent.intent.intentId);
  assert.ok(reservation);
  assert.equal(reservation.targetAt,plan.deliveries[0].scheduledFor);
  assert.equal(reservation.slotKey,plan.deliveries[0].slotKey);

  provenance.close(); runtime.close(); control.close();
});
