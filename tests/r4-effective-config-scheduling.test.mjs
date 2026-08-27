import test from "node:test";
import assert from "node:assert/strict";
import { EffectiveConfigurationChangeService } from "../dist/application/effective-configuration-change.js";
import { DEFAULT_DISTRIBUTION_RUNTIME_POLICY } from "../dist/domain/distribution-operations.js";

const oldPolicy={timeZone:"Europe/Vienna",slots:[{key:"09",localTime:"09:00"}],windowMinutes:30,maxPerAccountPerBusinessDate:4,minimumSpacingMinutes:120,overflowAllowed:false,overflowMinimumSpacingMinutes:240};
const newPolicy={...oldPolicy,slots:[{key:"10",localTime:"10:00"}]};

function fixture(){
  let config={revision:3,updatedAt:"2026-08-27T08:00:00.000Z",config:{sources:[],lanes:[],postingProfiles:[],copyProfiles:[],routes:[],activationCursors:[]},schedulePolicies:{default:oldPolicy},operatingCalendars:[],planningPolicy:{contentOrder:"FILENAME_NUMERIC_PREFIX",lateArrival:"NEXT_AVAILABLE_SLOT",overflow:"BACKLOG_NEXT_DAY"},runtimePolicy:structuredClone(DEFAULT_DISTRIBUTION_RUNTIME_POLICY)};
  const changes=new Map();
  const changeStore={
    create(change){if(changes.has(change.changeId))return changes.get(change.changeId);changes.set(change.changeId,structuredClone(change));return structuredClone(change);},
    get(id){return changes.has(id)?structuredClone(changes.get(id)):null;},
    list(status){return [...changes.values()].filter(c=>!status||c.status===status).map(structuredClone);},
    transition(id,to,at,reason){const current=changes.get(id);if(!current)throw new Error("missing change");const next={...current,status:to,...(to==="APPLIED"?{appliedAt:at}:{}),...(reason?{reason}:{})};changes.set(id,next);return structuredClone(next);}
  };
  const store={
    load(){return structuredClone(config);},
    save(next,expected){if(expected!==config.revision)throw new Error(`revision ${expected} stale`);config={...structuredClone(next),revision:config.revision+1};return structuredClone(config);}
  };
  return{service:new EffectiveConfigurationChangeService(changeStore,store,()=>[]),store,getConfig:()=>config,changes};
}

test("future rhythm change does not mutate today's active configuration",()=>{
  const f=fixture(),before=structuredClone(f.getConfig());
  const change=f.service.schedule({kind:"RHYTHM",payload:{id:"default",policy:newPolicy}},"2026-08-28","2026-08-27T08:05:00.000Z","operator");
  assert.equal(change.status,"PENDING");
  assert.deepEqual(f.getConfig(),before);
  assert.deepEqual(f.service.applyDue("2026-08-27","2026-08-27T12:00:00.000Z"),{inspected:0,applied:0,needsReview:0,changeIds:[]});
  const report=f.service.applyDue("2026-08-28","2026-08-28T00:01:00.000Z");
  assert.equal(report.applied,1);
  assert.deepEqual(f.getConfig().schedulePolicies.default.slots,newPolicy.slots);
});

test("future change becomes NEEDS_REVIEW instead of rebasing after unrelated config drift",()=>{
  const f=fixture();
  const change=f.service.schedule({kind:"RHYTHM",payload:{id:"default",policy:newPolicy}},"2026-08-28","2026-08-27T08:05:00.000Z","operator");
  const current=f.store.load();
  f.store.save({...current,updatedAt:"2026-08-27T09:00:00.000Z"},current.revision);
  const report=f.service.applyDue("2026-08-28","2026-08-28T00:01:00.000Z");
  assert.equal(report.applied,0);
  assert.equal(report.needsReview,1);
  assert.equal(f.changes.get(change.changeId).status,"NEEDS_REVIEW");
  assert.deepEqual(f.getConfig().schedulePolicies.default.slots,oldPolicy.slots);
});
