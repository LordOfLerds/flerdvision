import test from "node:test";
import assert from "node:assert/strict";
import { ProvenancedRuntimePlannerAdapter, RuntimeDistributionIntentMaterializerAdapter } from "../dist/application/runtime-distribution-adapters.js";

test("runtime planner decorator captures provenance before returning plan", async()=>{
  const order=[];
  const plan={planId:"p",businessDate:"2026-08-27",generatedAt:"2026-08-27T07:00:00Z",deliveries:[],gaps:[],backlog:[]};
  const inner={async ensureDailyPlan(){order.push("plan");return plan;}};
  const provenance={capture(value){order.push(`provenance:${value.planId}`);}};
  const result=await new ProvenancedRuntimePlannerAdapter(inner,provenance).ensureDailyPlan("2026-08-27","2026-08-27T07:00:00Z");
  assert.equal(result,plan);
  assert.deepEqual(order,["plan","provenance:p"]);
});

test("runtime materializer adapter preserves counts and exposes blocked issues to operations sink",async()=>{
  const seen=[];
  const inner={ensureIntents(){return{created:2,existing:1,blocked:1,issues:[{deliveryId:"d",routeId:"r",reason:"stale"}]}}};
  const sink={recordIssues(plan,issues){seen.push([plan.planId,issues[0].reason]);}};
  const adapter=new RuntimeDistributionIntentMaterializerAdapter(inner,sink);
  const report=await adapter.ensureIntents({planId:"p",businessDate:"2026-08-27",generatedAt:"x",deliveries:[],gaps:[],backlog:[]},"2026-08-27T07:00:00Z");
  assert.deepEqual(report,{created:2,existing:1,blocked:1});
  assert.deepEqual(seen,[["p","stale"]]);
});
