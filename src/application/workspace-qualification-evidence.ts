import type { ControlCenterRuntimeSnapshot } from "../domain/control-center-ports.js";
import type { StoredDistributionConfiguration } from "../domain/distribution-ports.js";
import type { QualificationGateKind } from "../domain/workspace.js";
import { resolveQualificationReplays } from "./qualification-policy.js";
import { currentSurfaceFingerprintOrUndefined, surfaceFingerprintMatches } from "./surface-fingerprint.js";

export interface DerivedQualificationEvidence {
  gate:QualificationGateKind;
  passed:true;
  summary:string;
  artifactRefs:readonly string[];
}

function dbRef(workspaceId:string,kind:string,id:string):string{return`db://workspace/${encodeURIComponent(workspaceId)}/${kind}/${encodeURIComponent(id)}`;}

export function deriveWorkspaceQualificationEvidence(input:{
  workspaceId:string;
  releaseSha:string;
  stored:StoredDistributionConfiguration;
  runtime:ControlCenterRuntimeSnapshot;
  /** When the run started. Identity evidence older than this does not qualify it. */
  qualificationStartedAt?:string;
  /**
   * Evaluation time. A source poll that is already overdue describes a host that has stopped
   * polling, so it must not qualify the source gate merely because it polled once in the past.
   */
  evaluatedAt?:string;
  /**
   * Accounts whose identity was verified after the run started. Without this constraint the
   * identity gate can pass on a check collected before the release under qualification even
   * existed, which is precisely the staleness the gate is meant to catch.
   */
  freshIdentityAccountIds?:readonly string[];
  /**
   * Surface fingerprint the route evidence must match. Route qualification follows the built
   * surface code, not the release SHA: an unrelated commit cannot invalidate a proven route.
   */
  surfaceFingerprint?:string;
}):readonly DerivedQualificationEvidence[]{
  const {workspaceId,releaseSha,stored,runtime}=input,out:DerivedQualificationEvidence[]=[];
  const requiredReplays=resolveQualificationReplays();
  const surfaceFingerprint=input.surfaceFingerprint??currentSurfaceFingerprintOrUndefined();
  const routeEvidenceCurrent=(test:{surfaceFingerprint?:string}|undefined):boolean=>surfaceFingerprintMatches(test?.surfaceFingerprint,surfaceFingerprint);
  const freshIdentity=input.freshIdentityAccountIds?new Set(input.freshIdentityAccountIds):null;
  const routes=stored.config.routes.filter(route=>route.enabled),requiredRoutes=routes.filter(route=>route.requirement==="REQUIRED");
  const routedLaneIds=[...new Set(routes.map(route=>route.laneId))];
  const activation=new Map((runtime.sourceActivation??[]).map(item=>[item.laneId,item]));
  const routedAccounts=[...new Set(routes.map(route=>route.accountId))];
  const channel=new Map(runtime.channelReadiness.map(item=>[item.accountId,item]));
  const tests=new Map(runtime.routeTests.map(item=>[item.routeId,item]));
  const surfaces=new Map((runtime.surfaceReadiness??[]).map(item=>[`${item.accountId}|${item.postingProfileId}`,item]));

  // Being slightly past nextPollAt is ordinary jitter; having missed an entire further interval
  // means the poller stopped. Only the latter invalidates the source evidence.
  const nextPollAt=runtime.sourcePolling?.nextPollAt;
  const intervalMinutes=stored.runtimePolicy?.sourcePolling?.activeIntervalMinutes??5;
  const pollOverdue=Boolean(
    input.evaluatedAt&&nextPollAt&&
    new Date(nextPollAt).getTime()+intervalMinutes*60_000<new Date(input.evaluatedAt).getTime()
  );
  const sourceWorkflow=routes.length>0&&Boolean(runtime.sourcePolling?.lastPollAt)&&!pollOverdue&&routedLaneIds.every(laneId=>{
    const state=activation.get(laneId)?.state;
    const activated=state==="CAPTURED"||state==="NOT_REQUIRED";
    const hasAsset=runtime.assets.some(asset=>asset.laneId===laneId);
    return activated&&hasAsset;
  });
  if(sourceWorkflow)out.push({
    gate:"SOURCE_WORKFLOW",passed:true,
    summary:`${routedLaneIds.length} routed lane(s) have activation evidence, observed asset state and a durable source poll.`,
    artifactRefs:[dbRef(workspaceId,"source-poll",runtime.sourcePolling!.lastPollAt!),...routedLaneIds.map(id=>dbRef(workspaceId,"source-lane",id))]
  });

  if(routes.length>0&&(runtime.legacySourceBindings?.needsMigration??0)===0)out.push({
    gate:"PROGRAM_ROUTING",passed:true,
    summary:`${routes.length} canonical DistributionRoute(s) exist and no active legacy source binding needs migration.`,
    artifactRefs:routes.map(route=>dbRef(workspaceId,"route",route.routeId))
  });

  const identityQualified=(accountId:string):boolean=>
    channel.get(accountId)?.sessionHealth==="HEALTHY"&&
    channel.get(accountId)?.identityVerified===true&&
    (freshIdentity===null||freshIdentity.has(accountId));
  if(routes.length>0&&routedAccounts.every(identityQualified))out.push({
    gate:"BROWSER_IDENTITY",passed:true,
    summary:`All ${routedAccounts.length} routed social account(s) have HEALTHY session and verified identity evidence${freshIdentity?` re-checked after the run started${input.qualificationStartedAt?` (${input.qualificationStartedAt})`:""}`:""}.`,
    artifactRefs:routedAccounts.map(id=>dbRef(workspaceId,"browser-identity",id))
  });

  const routeQualified=(route:typeof requiredRoutes[number]):boolean=>{
    const test=tests.get(route.routeId),surface=surfaces.get(`${route.accountId}|${route.postingProfileId}`);
    return Boolean(test&&routeEvidenceCurrent(test)&&test.sourcePassed&&test.sessionPassed&&test.identityPassed&&test.prepareOnlyPasses>=requiredReplays&&test.verificationPassed&&surface?.surfaceContract==="CALIBRATED"&&test.surfaceContractId&&test.surfaceContractId===surface.contractId);
  };
  if(requiredRoutes.length>0&&requiredRoutes.every(routeQualified))out.push({
    gate:"ROUTE_QUALIFICATION",passed:true,
    summary:`All ${requiredRoutes.length} REQUIRED route(s) are qualified against the current surface fingerprint.`,
    artifactRefs:requiredRoutes.map(route=>dbRef(workspaceId,"route-test",`${route.routeId}@${releaseSha}`))
  });

  const platformPrepare=(platform:"instagram"|"tiktok")=>{
    const platformRoutes=requiredRoutes.filter(route=>route.platform===platform);
    return platformRoutes.length>0&&platformRoutes.every(route=>{
      const test=tests.get(route.routeId);return Boolean(test&&routeEvidenceCurrent(test)&&test.prepareOnlyPasses>=requiredReplays);
    })?platformRoutes:null;
  };
  const igPrepare=platformPrepare("instagram");
  if(igPrepare)out.push({gate:"INSTAGRAM_PREPARE",passed:true,summary:`${igPrepare.length} REQUIRED Instagram route(s) each have at least ${requiredReplays} prepare-only pass(es) on the current surface.`,artifactRefs:igPrepare.map(route=>dbRef(workspaceId,"prepare-only",`${route.routeId}@${releaseSha}`))});
  const ttPrepare=platformPrepare("tiktok");
  if(ttPrepare)out.push({gate:"TIKTOK_PREPARE",passed:true,summary:`${ttPrepare.length} REQUIRED TikTok route(s) each have at least ${requiredReplays} prepare-only pass(es) on the current surface.`,artifactRefs:ttPrepare.map(route=>dbRef(workspaceId,"prepare-only",`${route.routeId}@${releaseSha}`))});

  const secretComplete=(platform:"instagram"|"tiktok")=>requiredRoutes.some(route=>{
    if(route.platform!==platform)return false;
    const test=tests.get(route.routeId);return Boolean(test&&routeEvidenceCurrent(test)&&test.secretLivePassed&&test.verificationPassed&&test.cleanupPassed);
  });
  if(secretComplete("instagram")&&secretComplete("tiktok")){
    const refs=requiredRoutes.filter(route=>{
      const test=tests.get(route.routeId);return Boolean((route.platform==="instagram"||route.platform==="tiktok")&&routeEvidenceCurrent(test)&&test?.secretLivePassed&&test.verificationPassed&&test.cleanupPassed);
    }).map(route=>dbRef(workspaceId,"secret-e2e",`${route.routeId}@${releaseSha}`));
    out.push({gate:"VERIFICATION_CLEANUP",passed:true,summary:"Instagram and TikTok secret-live paths both have verification + cleanup evidence on the current surface.",artifactRefs:refs});
    out.push({gate:"SECRET_E2E",passed:true,summary:"Instagram and TikTok secret-live E2E are both proven on the current surface.",artifactRefs:refs});
  }

  return out;
}
