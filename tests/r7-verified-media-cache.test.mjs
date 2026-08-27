import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { VerifiedMediaCacheMaterializer } from "../dist/adapters/publish/verified-media-cache.js";
import { VerifiedMediaCacheMaintenance } from "../dist/application/verified-media-cache-maintenance.js";

function sha(path){return createHash("sha256").update(readFileSync(path)).digest("hex");}
function content(){return{contentId:"content-1",acceptedFromObservationId:"obs",creatorId:"creator",mediaFingerprint:"provider-fingerprint",immutableMediaRef:"gdrive://file/file-1",metadata:{fileName:"clip.mp4",connectionId:"drive"}};}

test("verified media cache materializes provider only once and reuses exact bytes",async()=>{
  const root=mkdtempSync(join(tmpdir(),"flerdvision-verified-cache-")),provider=join(root,"provider.mp4");
  writeFileSync(provider,Buffer.from("immutable-video-bytes"));
  let calls=0,releases=0;
  const inner={
    async materialize(item){calls+=1;return{contentId:item.contentId,sourceRef:item.immutableMediaRef,localPath:provider,sha256:sha(provider),sizeBytes:readFileSync(provider).length};},
    async release(){releases+=1;}
  };
  const cache=new VerifiedMediaCacheMaterializer(inner,join(root,"verified"),()=>"2026-08-27T08:00:00.000Z");
  const first=await cache.materialize(content()),second=await cache.materialize(content());
  assert.equal(calls,1);
  assert.equal(releases,1);
  assert.equal(first.localPath,second.localPath);
  assert.equal(first.sha256,second.sha256);
  assert.notEqual(first.localPath,provider,"publisher uses cached copy, never original source path");
  await cache.release(first);
  assert.equal(readFileSync(first.localPath).toString(),"immutable-video-bytes","release does not evict verified bytes");
});

test("maintenance evicts only COMPLETE cache after configured retention",async()=>{
  const evicted=[];
  const maintenance=new VerifiedMediaCacheMaintenance({async get(){return null;},async evict(contentId,fingerprint){evicted.push([contentId,fingerprint]);return true;}});
  const base={laneId:"lane",creatorId:"creator",sourceObservationId:"obs",sourceRef:"ref",externalObjectId:"file",filename:"x.mp4",mediaFingerprint:"fp",observedAt:"2026-08-27T06:00:00.000Z",metadata:{}};
  const ready={...base,assetId:"ready",contentId:"content-ready",state:"READY"};
  const fresh={...base,assetId:"fresh",contentId:"content-fresh",state:"COMPLETE",metadata:{completedAt:"2026-08-27T11:00:00.000Z"}};
  const old={...base,assetId:"old",contentId:"content-old",state:"COMPLETE",metadata:{completedAt:"2026-08-26T08:00:00.000Z"}};
  const report=await maintenance.evictEligible([ready,fresh,old],"2026-08-27T12:00:00.000Z",24);
  assert.deepEqual(evicted,[["content-old","fp"]]);
  assert.equal(report.evicted,1);
  assert.equal(report.retained,2);
});
