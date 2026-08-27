import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkspacePublicationPayloadResolver, WorkspacePayloadConfigError } from "../dist/adapters/publish/workspace-payload-resolver.js";

const intent={intentId:"intent:1",contentId:"content:1",creatorId:"creator:1",platform:"instagram",accountId:"acct:1",format:"reel",copyVersionId:"copy:v7",scheduledFor:"2026-08-27T09:00:00Z",idempotencyKey:"idem"};
const store={getContentItem(id){return id==="content:1"?{item:{contentId:id,acceptedFromObservationId:"obs",creatorId:"creator:1",mediaFingerprint:"fp",immutableMediaRef:"file:///tmp/x.mp4",metadata:{fileName:"007-demo.mp4",campaign:"summer"}},createdAt:"2026-08-27T08:00:00Z"}:null;}};
function config(payloads){const root=mkdtempSync(join(tmpdir(),"fv-copy-")),path=join(root,"copy-payloads.json");writeFileSync(path,JSON.stringify({schemaVersion:1,payloads}),"utf8");return path;}

test("workspace payload resolver renders deterministic content metadata placeholders",async()=>{const resolver=new WorkspacePublicationPayloadResolver(config([{copyVersionId:"copy:v7",captionTemplate:"{filename} · {metadata.campaign} · {creatorId}",hashtags:["#demo","{metadata.campaign}"]}]),store);const payload=await resolver.resolve(intent);assert.equal(payload.caption,"007-demo.mp4 · summer · creator:1");assert.deepEqual(payload.hashtags,["demo","summer"]);});
test("workspace payload resolver refuses missing copy version instead of inventing copy",async()=>{const resolver=new WorkspacePublicationPayloadResolver(config([]),store);await assert.rejects(()=>resolver.resolve(intent),WorkspacePayloadConfigError);});
test("workspace payload resolver refuses unknown metadata placeholders",async()=>{const resolver=new WorkspacePublicationPayloadResolver(config([{copyVersionId:"copy:v7",captionTemplate:"{metadata.missing}"}]),store);await assert.rejects(()=>resolver.resolve(intent),/Unknown payload metadata placeholder/);});
test("platform required copy field is fail closed",async()=>{const resolver=new WorkspacePublicationPayloadResolver(config([{copyVersionId:"copy:v7",titleTemplate:"not enough for IG"}]),store);await assert.rejects(()=>resolver.resolve(intent),/requires a configured caption/);});
