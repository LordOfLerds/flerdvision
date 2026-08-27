import test from "node:test";
import assert from "node:assert/strict";
import { SqliteControlPlaneStore } from "../dist/adapters/storage/sqlite.js";
import { RecoveryOnlyRuntimeReconciliationAdapter } from "../dist/adapters/runtime/safe-phase-adapters.js";
import { PublicationScheduler, DueWorkClaimer } from "../dist/application/scheduler.js";
import { instantForLocalDateTime } from "../dist/domain/scheduling.js";

const actor={type:"test",id:"runtime-recovery"},created="2026-08-27T05:00:00.000Z",target=instantForLocalDateTime("2026-08-27","09:00","Europe/Vienna");
function scheduled(store,id){store.createOrGetIntent({intentId:id,contentId:`content-${id}`,creatorId:"creator",platform:"instagram",accountId:`account-${id}`,format:"reel",copyVersionId:"copy",scheduledFor:target,idempotencyKey:`idem-${id}`},created,actor);store.transitionIntent(id,"READY",created,actor);new PublicationScheduler(store).scheduleIntent(id,created,actor);}

test("runtime recovery safely rolls expired PREPARING back and never returns SAFE_TO_RETRY",async()=>{const store=new SqliteControlPlaneStore(":memory:");try{scheduled(store,"safe");new DueWorkClaimer(store).claimNext("dead",target,1);const report=await new RecoveryOnlyRuntimeReconciliationAdapter(store).reconcile("2026-08-27T07:00:02.000Z");assert.equal(store.getIntent("safe")?.state,"SCHEDULED");assert.equal(report.safeToRetry,0);assert.equal(report.verified,0);assert.equal(report.stillUncertain,0);}finally{store.close();}});
test("runtime recovery marks expired PUBLISHING uncertain and leaves it for real reconciliation",async()=>{const store=new SqliteControlPlaneStore(":memory:");try{scheduled(store,"unsafe");new DueWorkClaimer(store).claimNext("dead",target,1);store.transitionIntent("unsafe","PUBLISHING",target,actor,"boundary");const report=await new RecoveryOnlyRuntimeReconciliationAdapter(store).reconcile("2026-08-27T07:00:02.000Z");assert.equal(store.getIntent("unsafe")?.state,"PUBLISH_UNCERTAIN");assert.equal(report.safeToRetry,0);assert.equal(report.verified,0);assert.equal(report.stillUncertain,1);}finally{store.close();}});
