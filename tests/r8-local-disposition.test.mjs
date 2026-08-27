import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalMoveDispositionAdapter, LocalSidecarDispositionAdapter, LocalSourceDispositionError } from "../dist/adapters/disposition/local-files.js";

function fixture(){const root=mkdtempSync(join(tmpdir(),"fv-disposition-")),source=join(root,"clip.mp4");writeFileSync(source,"video");const lookup={getSourceObservation(id){return id==="obs"?{observation:{observationId:"obs",sourceId:"lane",externalObjectId:"clip.mp4",observedAt:"2026-08-27T08:00:00Z",locator:new URL(`file://${source}`).toString(),metadata:{localPath:source}}}:null;}};return{root,source,lookup};}

test("local sidecar is deterministic and idempotent but never overwrites conflicting state",async()=>{const f=fixture();try{const adapter=new LocalSidecarDispositionAdapter(f.lookup,f.root),sidecar=`${f.source}.flerdvision.json`;await adapter.markCompleted("obs",["pub-2","pub-1"]);const first=readFileSync(sidecar,"utf8");await adapter.markCompleted("obs",["pub-1","pub-2"]);assert.equal(readFileSync(sidecar,"utf8"),first);writeFileSync(sidecar,"conflict\n");await assert.rejects(()=>adapter.markCompleted("obs",["pub-1"]),LocalSourceDispositionError);}finally{rmSync(f.root,{recursive:true,force:true});}});
test("local move refuses overwrite and is idempotent after its own completed move",async()=>{const f=fixture();try{const done=join(f.root,"done");mkdirSync(done);const adapter=new LocalMoveDispositionAdapter(f.lookup,f.root,"done"),target=join(done,"clip.mp4");await adapter.markCompleted("obs",[]);assert.equal(existsSync(f.source),false);assert.equal(existsSync(target),true);await adapter.markCompleted("obs",[]);assert.equal(existsSync(target),true);}finally{rmSync(f.root,{recursive:true,force:true});}});
test("local move destination cannot escape source root",()=>{const f=fixture();try{assert.throws(()=>new LocalMoveDispositionAdapter(f.lookup,f.root,"../outside"),/escapes source root/);}finally{rmSync(f.root,{recursive:true,force:true});}});
