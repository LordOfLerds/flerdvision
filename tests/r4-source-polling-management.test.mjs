import test from "node:test";
import assert from "node:assert/strict";
import { SourcePollingPolicyManagementService } from "../dist/application/source-polling-management.js";
import { DEFAULT_DISTRIBUTION_RUNTIME_POLICY } from "../dist/domain/distribution-operations.js";

function fixture(){
  let stored={
    revision:7,updatedAt:"2026-08-27T08:00:00.000Z",
    config:{sources:[],lanes:[],postingProfiles:[],copyProfiles:[],routes:[],activationCursors:[]},
    schedulePolicies:{default:{timeZone:"Europe/Vienna",slots:[{key:"09",localTime:"09:00"}],windowMinutes:30,maxPerAccountPerBusinessDate:4,minimumSpacingMinutes:120,overflowAllowed:false,overflowMinimumSpacingMinutes:240}},
    operatingCalendars:[],
    planningPolicy:{contentOrder:"FILENAME_NUMERIC_PREFIX",lateArrival:"NEXT_AVAILABLE_SLOT",overflow:"BACKLOG_NEXT_DAY"},
    runtimePolicy:structuredClone(DEFAULT_DISTRIBUTION_RUNTIME_POLICY)
  };
  const store={
    load(){return structuredClone(stored);},
    save(next,expectedRevision){assert.equal(expectedRevision,stored.revision);stored={...structuredClone(next),revision:stored.revision+1};return structuredClone(stored);}
  };
  return{store,get(){return stored;}};
}

test("source polling change preserves routes, schedules, planner policy and readiness/cache policy",()=>{
  const f=fixture(),before=structuredClone(f.get()),service=new SourcePollingPolicyManagementService(f.store);
  const next={timeZone:"Europe/Vienna",activeWindowStartLocal:"05:30",activeWindowEndLocal:"20:00",activeIntervalMinutes:3,idleIntervalMinutes:20,pollImmediatelyOnStartup:true};
  const preview=service.preview(next);
  assert.equal(preview.invalidateFutureDailyPlans,false);
  assert.equal(preview.requireRouteRetest,false);
  service.save(next,7,"2026-08-27T08:05:00.000Z");
  const after=f.get();
  assert.deepEqual(after.config,before.config);
  assert.deepEqual(after.schedulePolicies,before.schedulePolicies);
  assert.deepEqual(after.planningPolicy,before.planningPolicy);
  assert.deepEqual(after.operatingCalendars,before.operatingCalendars);
  assert.deepEqual(after.runtimePolicy.readiness,before.runtimePolicy.readiness);
  assert.deepEqual(after.runtimePolicy.mediaCache,before.runtimePolicy.mediaCache);
  assert.deepEqual(after.runtimePolicy.sourcePolling,next);
});

test("source polling change fails closed on stale config revision",()=>{
  const f=fixture(),service=new SourcePollingPolicyManagementService(f.store);
  const next={...DEFAULT_DISTRIBUTION_RUNTIME_POLICY.sourcePolling,activeIntervalMinutes:2};
  assert.throws(()=>service.save(next,6,"2026-08-27T08:05:00.000Z"),/stale/);
});
