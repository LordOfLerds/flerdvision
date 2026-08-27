import type { ControlCenterRuntimeSnapshot } from "../domain/control-center-ports.js";
import type { StoredDistributionConfiguration } from "../domain/distribution-ports.js";

export type WorkflowStatus = "READY" | "NEEDS_ACTION" | "BLOCKED" | "SAFE_FROZEN";

export interface WorkflowCard {
  workflowId:string;
  label:string;
  purpose:string;
  status:WorkflowStatus;
  detail:string;
  deepLink:string;
  metrics:Readonly<Record<string,number|string>>;
}

export interface WorkflowCenterModel {
  businessDate:string;
  cards:readonly WorkflowCard[];
  summary:{ready:number;needsAction:number;blocked:number;safeFrozen:number};
}

function routeQualification(stored:StoredDistributionConfiguration,runtime:ControlCenterRuntimeSnapshot,routeId:string):{qualified:boolean;reason:string}{
  const route=stored.config.routes.find(item=>item.routeId===routeId);
  if(!route)return{qualified:false,reason:"route missing"};
  const account=runtime.accounts.find(item=>item.accountId===route.accountId);
  const channel=runtime.channelReadiness.find(item=>item.accountId===route.accountId);
  const surface=(runtime.surfaceReadiness??[]).find(item=>item.accountId===route.accountId&&item.postingProfileId===route.postingProfileId);
  const test=runtime.routeTests.find(item=>item.routeId===routeId);
  if(!route.enabled)return{qualified:false,reason:"route paused"};
  if(!account?.enabled)return{qualified:false,reason:"account missing or paused"};
  if(channel?.sessionHealth!=="HEALTHY")return{qualified:false,reason:`session ${channel?.sessionHealth??"UNKNOWN"}`};
  if(!channel.identityVerified)return{qualified:false,reason:"identity not verified"};
  if(surface?.surfaceContract!=="CALIBRATED")return{qualified:false,reason:`surface ${surface?.surfaceContract??"UNVERIFIED"}`};
  if(!test?.sourcePassed||!test.sessionPassed||!test.identityPassed)return{qualified:false,reason:"observer route tests incomplete"};
  if(test.prepareOnlyPasses<3)return{qualified:false,reason:`prepare-only ${test.prepareOnlyPasses}/3`};
  if(!test.verificationPassed)return{qualified:false,reason:"verification test incomplete"};
  return{qualified:true,reason:"qualified"};
}

export function projectWorkflowCenter(input:{stored:StoredDistributionConfiguration;runtime:ControlCenterRuntimeSnapshot;businessDate:string}):WorkflowCenterModel{
  const {stored,runtime,businessDate}=input;
  const enabledSources=stored.config.sources.filter(item=>item.enabled);
  const enabledLanes=stored.config.lanes.filter(item=>item.enabled);
  const activationByLane=new Map((runtime.sourceActivation??[]).map(item=>[item.laneId,item]));
  const activationBlocked=enabledLanes.filter(lane=>{
    const state=activationByLane.get(lane.laneId)?.state;
    return state==="MISSING_BASELINE"||state==="MISCONFIGURED";
  });

  const enabledRoutes=stored.config.routes.filter(item=>item.enabled);
  const qualification=enabledRoutes.map(route=>({routeId:route.routeId,...routeQualification(stored,runtime,route.routeId)}));
  const qualifiedRoutes=qualification.filter(item=>item.qualified).length;
  const storyProfileIds=new Set(stored.config.postingProfiles.filter(item=>item.enabled&&item.platform==="instagram"&&item.format==="story").map(item=>item.postingProfileId));
  const storyRoutes=enabledRoutes.filter(route=>storyProfileIds.has(route.postingProfileId));
  const qualifiedStoryRoutes=storyRoutes.filter(route=>routeQualification(stored,runtime,route.routeId).qualified).length;

  const aggregates=runtime.deliveryAggregates??[];
  const complete=aggregates.filter(item=>item.status==="COMPLETE").length;
  const partial=aggregates.filter(item=>item.status==="PARTIAL").length;
  const blockedAggregates=aggregates.filter(item=>item.status==="BLOCKED").length;
  const latestCycle=(runtime.runtimeCycles??[]).at(-1);

  const cards:WorkflowCard[]=[
    {
      workflowId:"source-intake",
      label:"Content Intake",
      purpose:"Google Drive / Local → Lane → Asset → Media-Readiness",
      status:enabledSources.length===0||enabledLanes.length===0?"BLOCKED":activationBlocked.length>0?"NEEDS_ACTION":"READY",
      detail:enabledSources.length===0||enabledLanes.length===0?"Keine aktive Source/Lane konfiguriert.":activationBlocked.length>0?`${activationBlocked.length} Lane(s) brauchen Baseline/Repair.`:"Source-Lifecycle ist konfiguriert; Scan und NEW_ONLY-Baseline sind im Control Center bedienbar.",
      deepLink:"/sources",
      metrics:{sources:enabledSources.length,lanes:enabledLanes.length,assets:runtime.assets.length,activationBlocks:activationBlocked.length}
    },
    {
      workflowId:"daily-plan",
      label:"Daily Planning",
      purpose:"Assets → DailyPlan → Backlog/Gaps → Intent/Reservation",
      status:enabledRoutes.length===0?"BLOCKED":runtime.plan.gaps.length>0?"NEEDS_ACTION":"READY",
      detail:enabledRoutes.length===0?"Keine aktive DistributionRoute vorhanden.":runtime.plan.gaps.length>0?`${runtime.plan.gaps.length} Plan-Gap(s) müssen geprüft werden.`:`Plan ${runtime.plan.planId} ist für ${businessDate} vorhanden.`,
      deepLink:"/today",
      metrics:{deliveries:runtime.plan.deliveries.length,gaps:runtime.plan.gaps.length,backlog:runtime.plan.backlog.length,routes:enabledRoutes.length}
    },
    {
      workflowId:"daily-story",
      label:"Daily Story",
      purpose:"Tägliche Instagram Story über denselben Route-/Planner-/Browser-Pfad",
      status:storyRoutes.length===0?"NEEDS_ACTION":qualifiedStoryRoutes===storyRoutes.length?"SAFE_FROZEN":"NEEDS_ACTION",
      detail:storyRoutes.length===0?"Noch keine aktive Instagram-Story-Route. Sie kann in Programs mit einem Story-Posting-Profile angelegt werden.":qualifiedStoryRoutes===storyRoutes.length?"Story-Routen sind qualifiziert; Final Publish bleibt bis zum expliziten Live-Gate gesperrt.":`${qualifiedStoryRoutes}/${storyRoutes.length} Story-Route(s) vollständig qualifiziert.`,
      deepLink:storyRoutes.length===0?"/programs":"/test-lab",
      metrics:{storyRoutes:storyRoutes.length,qualifiedStoryRoutes}
    },
    {
      workflowId:"route-qualification",
      label:"Route Qualification",
      purpose:"Source → Session → Identity → Surface → PREPARE_ONLY ×3 → Verification",
      status:enabledRoutes.length===0?"BLOCKED":qualifiedRoutes===enabledRoutes.length?"SAFE_FROZEN":"NEEDS_ACTION",
      detail:enabledRoutes.length===0?"Keine Route zum Qualifizieren.":qualifiedRoutes===enabledRoutes.length?"Alle aktiven Routen erfüllen die Test-Evidence; Live bleibt separat permit-gated.":`${qualifiedRoutes}/${enabledRoutes.length} aktive Route(s) erfüllen die vollständige Qualification.`,
      deepLink:"/test-lab",
      metrics:{routes:enabledRoutes.length,qualifiedRoutes,remaining:Math.max(0,enabledRoutes.length-qualifiedRoutes)}
    },
    {
      workflowId:"delivery-reconciliation",
      label:"Delivery / Reconciliation",
      purpose:"Publish evidence → DeliveryAggregate → Disposition → Incident/Recovery",
      status:blockedAggregates>0?"NEEDS_ACTION":"READY",
      detail:blockedAggregates>0?`${blockedAggregates} DeliveryAggregate(s) sind BLOCKED.`:"DeliveryAggregate-, Reconciliation- und Disposition-Pfad ist im Runtime-Supervisor verdrahtet.",
      deepLink:blockedAggregates>0?"/incidents":"/content",
      metrics:{complete,partial,blocked:blockedAggregates,total:aggregates.length}
    },
    {
      workflowId:"metrics-tracker",
      label:"Metrics / Tracker",
      purpose:"Operativer Tracker aus DailyPlan, Assets, Runtime-Cycles und DeliveryAggregates",
      status:"READY",
      detail:"Der Tracker wird direkt aus durable Runtime-State projiziert; kein separater Spreadsheet-Scheduler oder zweiter Wahrheitsbaum nötig.",
      deepLink:"/workflows",
      metrics:{assets:runtime.assets.length,planned:runtime.plan.deliveries.length,completeDeliveries:complete,runtimeCycles:(runtime.runtimeCycles??[]).length,lastCycle:latestCycle?.endedAt??"none"}
    }
  ];

  return{
    businessDate,
    cards,
    summary:{
      ready:cards.filter(item=>item.status==="READY").length,
      needsAction:cards.filter(item=>item.status==="NEEDS_ACTION").length,
      blocked:cards.filter(item=>item.status==="BLOCKED").length,
      safeFrozen:cards.filter(item=>item.status==="SAFE_FROZEN").length
    }
  };
}
