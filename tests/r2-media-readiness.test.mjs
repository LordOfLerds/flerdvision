import test from "node:test";
import assert from "node:assert/strict";
import { MaterializingMediaReadinessProbe } from "../dist/adapters/distribution/materializing-readiness-probe.js";

const content={contentId:"content",creatorId:"creator",mediaFingerprint:"provider-fp",immutableMediaRef:"file:///tmp/video.mp4",metadata:{connectionId:"src"}};
function materializer(sizeBytes=100){return{async materialize(){return{contentId:"content",sourceRef:content.immutableMediaRef,localPath:"/tmp/video.mp4",sha256:"a".repeat(64),sizeBytes};},async release(){}};}

test("materialized bytes are not READY without valid positive-duration video inspection",async()=>{
  const probe=new MaterializingMediaReadinessProbe(materializer(),{async inspect(){return{validVideo:false,videoStreams:0,audioStreams:0,note:"no video"};}});
  const result=await probe.probe(content);
  assert.equal(result.outcome,"BLOCKED");
  assert.equal(result.sha256,"a".repeat(64));
});

test("valid inspected video becomes READABLE with duration evidence",async()=>{
  const probe=new MaterializingMediaReadinessProbe(materializer(),{async inspect(){return{validVideo:true,videoStreams:1,audioStreams:1,durationSeconds:12.5,formatName:"mov,mp4"};}});
  const result=await probe.probe(content);
  assert.equal(result.outcome,"READABLE");
  assert.equal(result.durationSeconds,12.5);
  assert.equal(result.sizeBytes,100);
});

test("inspector/provider execution failure is retryable, not silently valid",async()=>{
  const probe=new MaterializingMediaReadinessProbe(materializer(),{async inspect(){throw new Error("ffprobe unavailable");}});
  const result=await probe.probe(content);
  assert.equal(result.outcome,"RETRY");
  assert.match(result.note,/ffprobe unavailable/);
});
