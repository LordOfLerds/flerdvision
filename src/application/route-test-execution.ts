import { createHash } from "node:crypto";
import type { E2EGateResult } from "../domain/e2e.js";
import type { RouteTestExecutionAdapterPort, RouteTestEvidenceKey, RouteTestEvidenceRecord, RouteTestEvidenceStorePort, ExecutableRouteTestKey } from "../domain/route-test-ports.js";
import type { RouteTestReadiness } from "../domain/route-test-readiness.js";
import { currentSurfaceFingerprintOrUndefined } from "./surface-fingerprint.js";

export class RouteTestExecutionError extends Error {}

function id(routeId: string, key: string, checkedAt: string, summary: string): string {
  return `route-test:${createHash("sha256").update(`${routeId}|${key}|${checkedAt}|${summary}`).digest("hex").slice(0,24)}`;
}
function latest(records: readonly RouteTestEvidenceRecord[], key: RouteTestEvidenceKey): RouteTestEvidenceRecord | undefined {
  return records.filter((r)=>r.testKey===key).sort((a,b)=>a.checkedAt.localeCompare(b.checkedAt)).at(-1);
}
function passed(records: readonly RouteTestEvidenceRecord[], key: RouteTestEvidenceKey): boolean { return latest(records,key)?.status === "PASS"; }
const SURFACE_SENSITIVE = new Set<RouteTestEvidenceKey>(["SURFACE","PREPARE_ONLY","SECRET_LIVE","VERIFICATION","CLEANUP"]);
const CONTRACT_BOUND = new Set<RouteTestEvidenceKey>(["SURFACE","PREPARE_ONLY","VERIFICATION"]);

export interface RouteReadinessScope {
  releaseSha?: string;
  surfaceFingerprint?: string;
  surfaceRecordedAt?: string;
  surfaceContractId?: string;
}

function scoped(records:readonly RouteTestEvidenceRecord[],scope:RouteReadinessScope):RouteTestEvidenceRecord[]{
  return records.filter(record=>{
    if(scope.releaseSha&&record.releaseSha!==scope.releaseSha)return false;
    if(scope.surfaceRecordedAt&&SURFACE_SENSITIVE.has(record.testKey)&&record.checkedAt<scope.surfaceRecordedAt)return false;
    if(scope.surfaceContractId&&CONTRACT_BOUND.has(record.testKey)&&record.surfaceContractId!==scope.surfaceContractId)return false;
    return true;
  });
}

export class RouteTestExecutionService {
  constructor(private readonly store: RouteTestEvidenceStorePort, private readonly runner: RouteTestExecutionAdapterPort) {}

  async run(routeId: string, testKey: ExecutableRouteTestKey, releaseSha: string, now: string, scope:RouteReadinessScope={}): Promise<RouteTestEvidenceRecord> {
    if (!routeId.trim() || !releaseSha.trim()) throw new RouteTestExecutionError("Route and release SHA are required");
    const checkedAt=new Date(now).toISOString(),existing=scoped(this.store.list(routeId),{...scope,releaseSha});
    if (testKey === "IDENTITY" && !passed(existing,"SESSION")) throw new RouteTestExecutionError("Identity test requires a passing session test on this release");
    if (testKey === "SURFACE" && !passed(existing,"IDENTITY")) throw new RouteTestExecutionError("Surface test requires a passing identity test on this release");
    if (testKey === "PREPARE_ONLY" && !(passed(existing,"SOURCE") && passed(existing,"SESSION") && passed(existing,"IDENTITY"))) throw new RouteTestExecutionError("Prepare-only requires source, session and identity PASS on this release");
    if (testKey === "VERIFICATION" && !passed(existing,"SURFACE")) throw new RouteTestExecutionError("Verification contract test requires a current calibrated/passing surface on this release");
    if (testKey === "CLEANUP" && !passed(existing,"SECRET_LIVE")) throw new RouteTestExecutionError("Cleanup may run only after canonical secret-live E2E evidence exists on this release");
    const result=await this.runner.run(routeId,testKey,checkedAt);
    if(scope.surfaceContractId&&CONTRACT_BOUND.has(testKey)&&result.surfaceContractId!==scope.surfaceContractId)throw new RouteTestExecutionError(`Route test ${testKey} executed against surface ${result.surfaceContractId??"NONE"}, expected ${scope.surfaceContractId}`);
    const surfaceFingerprint=scope.surfaceFingerprint??currentSurfaceFingerprintOrUndefined();
    return this.store.record({ evidenceId:id(routeId,testKey,checkedAt,result.summary), routeId, testKey, status:result.passed?"PASS":"FAIL", checkedAt, releaseSha,...(surfaceFingerprint?{surfaceFingerprint}:{}),...(result.surfaceContractId?{surfaceContractId:result.surfaceContractId}:{}),summary:result.summary, artifactRefs:[...result.artifactRefs] });
  }

  readiness(routeId: string, scope:RouteReadinessScope={}): RouteTestReadiness {
    const records=scoped(this.store.list(routeId),scope);
    return{routeId,sourcePassed:passed(records,"SOURCE"),sessionPassed:passed(records,"SESSION"),identityPassed:passed(records,"IDENTITY"),prepareOnlyPasses:records.filter((r)=>r.testKey==="PREPARE_ONLY"&&r.status==="PASS").length,secretLivePassed:passed(records,"SECRET_LIVE"),verificationPassed:passed(records,"VERIFICATION"),cleanupPassed:passed(records,"CLEANUP"),...(scope.releaseSha?{releaseSha:scope.releaseSha}:{}),...(scope.surfaceFingerprint?{surfaceFingerprint:scope.surfaceFingerprint}:{}),...(scope.surfaceContractId?{surfaceContractId:scope.surfaceContractId}:{})};
  }

  assertSecretLiveUsesPrivateE2E(): never { throw new RouteTestExecutionError("SECRET_LIVE cannot be executed by RouteTestExecutionService; start the canonical PrivateE2E run and one-shot permit flow instead"); }
}

function mapGate(gate: E2EGateResult): RouteTestEvidenceKey | null {if(gate.gate==="PREPARE_ONLY_REPLAY")return"PREPARE_ONLY";if(gate.gate==="PRIVATE_PUBLISH")return"SECRET_LIVE";if(gate.gate==="VERIFICATION")return"VERIFICATION";if(gate.gate==="CLEANUP")return"CLEANUP";return null;}
export class RouteE2EGateBridge {
  constructor(private readonly store: RouteTestEvidenceStorePort) {}
  recordGate(routeId: string, gate: E2EGateResult, releaseSha: string, surfaceContractId?:string, surfaceFingerprint?:string): RouteTestEvidenceRecord | null {
    const testKey=mapGate(gate);if(!testKey)return null;
    // Private E2E evidence is read back under the surface fingerprint like every other route
    // test; without it a real private post would keep reading as "not run".
    const fingerprint=surfaceFingerprint??currentSurfaceFingerprintOrUndefined();
    return this.store.record({evidenceId:id(routeId,testKey,gate.checkedAt,gate.gateResultId),routeId,testKey,status:gate.status==="PASS"?"PASS":"FAIL",checkedAt:gate.checkedAt,releaseSha,...(fingerprint?{surfaceFingerprint:fingerprint}:{}),...(surfaceContractId?{surfaceContractId}:{}),summary:`Private E2E ${gate.gate}: ${gate.summary}`,artifactRefs:[...gate.artifactRefs]});
  }
}
