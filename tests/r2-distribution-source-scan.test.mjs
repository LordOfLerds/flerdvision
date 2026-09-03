import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqliteControlPlaneStore } from "../dist/adapters/storage/sqlite.js";
import { SqliteDistributionRuntimeStateStore } from "../dist/adapters/distribution/sqlite-runtime-state.js";
import { DistributionSourceScanCoordinator } from "../dist/application/distribution-source-scan.js";

function storedConfig(mode="IMPORT_BACKLOG"){
  return{
    revision:1,updatedAt:"2026-08-27T08:00:00.000Z",
    config:{
      sources:[{connectionId:"src",displayName:"Drive",kind:"google_drive",rootRef:"root",enabled:true,disposition:{mode:"database_only",leavePartialUntouched:true,leaveBlockedUntouched:true}}],
      lanes:[{laneId:"lane",connectionId:"src",displayName:"Lane",folderRef:"folder",folderPath:"Lane",interpretation:{kind:"flat"},enabled:true}],
      postingProfiles:[],copyProfiles:[],routes:[],
      activationCursors:[{laneId:"lane",mode,activatedAt:"2026-08-27T08:00:00.000Z"}]
    },
    schedulePolicies:{},planningPolicy:{contentOrder:"FILENAME_NUMERIC_PREFIX",lateArrival:"NEXT_AVAILABLE_SLOT",overflow:"BACKLOG_NEXT_DAY"}
  };
}
function obs(fingerprint="fp-a"){
  return{observationId:"obs-1",sourceId:"lane:lane",externalObjectId:"file-1",observedAt:"2026-08-27T08:05:00.000Z",locator:"gdrive://file/file-1",mediaFingerprint:fingerprint,metadata:{fileName:"01.mp4",size:"100",businessDate:"2026-08-27"}};
}
function noBaselines(){return{getBaseline(){return null;},putBaseline(){throw new Error("not expected");}};}
function interpreterFactory(){return{forLane(){return{async interpret(observation){return{observationId:observation.observationId,decision:"accept",creatorId:"creator",scheduledBusinessDate:"2026-08-27"};}};}};}
const disposition={async markCompleted(){},async markBlocked(){}};

test("accepted media requires repeated identical observation plus materialization before READY",async()=>{
  const root=mkdtempSync(join(tmpdir(),"flerdvision-lane-scan-"));
  const db=join(root,"state.sqlite");
  const ingress=new SqliteControlPlaneStore(db);
  const runtime=new SqliteDistributionRuntimeStateStore(db);
  let current=obs();
  const coordinator=new DistributionSourceScanCoordinator(
    {load(){return storedConfig();},save(){throw new Error("read only");}},
    {async observeLane(){return[current];}},
    interpreterFactory(),ingress,disposition,noBaselines(),runtime,
    {async probe(){return{outcome:"READABLE",sha256:"local-sha",sizeBytes:100};}}
  );

  const first=await coordinator.run("2026-08-27T08:05:00.000Z");
  assert.equal(first.stabilizing,1);
  const firstAsset=runtime.listAssets()[0].asset;
  assert.equal(firstAsset.state,"STABILIZING");

  const second=await coordinator.run("2026-08-27T08:06:00.000Z");
  assert.equal(second.ready,1);
  const ready=runtime.getAsset(firstAsset.assetId).asset;
  assert.equal(ready.state,"READY");
  assert.equal(ready.metadata.readinessSha256,"local-sha");
  assert.equal(ingress.getSourceObservation("obs-1").seenCount,2);

  current=obs("fp-mutated");
  const third=await coordinator.run("2026-08-27T08:07:00.000Z");
  assert.ok(third.conflicts>=1);
  assert.equal(runtime.getAsset(firstAsset.assetId).asset.state,"BLOCKED");
  runtime.close(); ingress.close();
});

test("NEW_ONLY lane without explicit baseline fails closed before source scan",async()=>{
  const root=mkdtempSync(join(tmpdir(),"flerdvision-lane-baseline-"));
  const db=join(root,"state.sqlite");
  const ingress=new SqliteControlPlaneStore(db);
  const runtime=new SqliteDistributionRuntimeStateStore(db);
  let observed=false;
  const coordinator=new DistributionSourceScanCoordinator(
    {load(){return storedConfig("NEW_ONLY");},save(){throw new Error("read only");}},
    {async observeLane(){observed=true;return[obs()];}},
    interpreterFactory(),ingress,disposition,noBaselines(),runtime,
    {async probe(){throw new Error("not expected");}}
  );
  const report=await coordinator.run("2026-08-27T08:05:00.000Z");
  assert.equal(observed,false);
  assert.equal(report.blocked,1);
  assert.match(report.lanes[0].notes[0],/baseline_missing/);
  runtime.close(); ingress.close();
});

test("a file that turns BLOCKED reaches the operator once per revision, with the file name and what to do", async () => {
  const root = mkdtempSync(join(tmpdir(), "flerdvision-lane-blocked-"));
  const db = join(root, "state.sqlite");
  const ingress = new SqliteControlPlaneStore(db);
  const runtime = new SqliteDistributionRuntimeStateStore(db);
  const enqueued = [];
  const outbox = {
    enqueueNotification(message, channelKeys) {
      // The real outbox dedupes on dedupeKey; mirror that so the test proves the key, not luck.
      if (enqueued.some((item) => item.dedupeKey === message.dedupeKey)) return [];
      enqueued.push(message);
      return channelKeys.map((key) => ({ notificationId: message.notificationId, channelKey: key, status: "PENDING", attempts: 0 }));
    }
  };
  let outcome = { outcome: "RETRY", note: "media_probe_retry" };
  const coordinator = new DistributionSourceScanCoordinator(
    { load() { return storedConfig(); }, save() { throw new Error("read only"); } },
    { async observeLane() { return [{ ...obs(), metadata: { fileName: "01_Sonnenuntergang am See #nature.mp4", size: "100", businessDate: "2026-08-27" } }]; } },
    interpreterFactory(), ingress, disposition, noBaselines(), runtime,
    { async probe() { return outcome; } },
    { notifyBlocksExternally: false, outbox, notificationChannelKeys: ["telegram"] }
  );

  await coordinator.run("2026-08-27T08:05:00.000Z");
  await coordinator.run("2026-08-27T08:06:00.000Z");
  assert.equal(runtime.listAssets()[0].asset.state, "STABILIZING");
  assert.equal(enqueued.length, 0, "a file that is merely still settling must stay silent");

  outcome = { outcome: "BLOCKED", note: "media_probe_blocked" };
  await coordinator.run("2026-08-27T08:08:00.000Z");
  assert.equal(runtime.listAssets()[0].asset.state, "BLOCKED");
  assert.equal(enqueued.length, 1);
  assert.match(enqueued[0].subject, /Datei blockiert/);
  assert.match(enqueued[0].body, /Sonnenuntergang am See/);
  assert.match(enqueued[0].body, /Das Video lässt sich nicht lesen/);
  assert.match(enqueued[0].body, /Datei in Drive ersetzen — der Slot bleibt frei\./);
  // Deduped per asset revision: the media fingerprint is part of the key, so a replaced file
  // is announced again while re-scanning the same broken one stays quiet.
  assert.match(enqueued[0].dedupeKey, /^asset-blocked:asset:[0-9a-f]+:fp-a$/);

  await coordinator.run("2026-08-27T08:10:00.000Z");
  assert.equal(enqueued.length, 1);
  runtime.close(); ingress.close();
});

test("without a configured notification channel a blocked file changes nothing but the state", async () => {
  const root = mkdtempSync(join(tmpdir(), "flerdvision-lane-blocked-quiet-"));
  const db = join(root, "state.sqlite");
  const ingress = new SqliteControlPlaneStore(db);
  const runtime = new SqliteDistributionRuntimeStateStore(db);
  let calls = 0;
  const coordinator = new DistributionSourceScanCoordinator(
    { load() { return storedConfig(); }, save() { throw new Error("read only"); } },
    { async observeLane() { return [obs()]; } },
    interpreterFactory(), ingress, disposition, noBaselines(), runtime,
    { async probe() { return { outcome: "BLOCKED", note: "media_probe_blocked" }; } },
    { outbox: { enqueueNotification() { calls += 1; return []; } }, notificationChannelKeys: [] }
  );
  await coordinator.run("2026-08-27T08:05:00.000Z");
  await coordinator.run("2026-08-27T08:06:00.000Z");
  assert.equal(calls, 0);
  assert.equal(runtime.listAssets()[0].asset.state, "BLOCKED");
  runtime.close(); ingress.close();
});
