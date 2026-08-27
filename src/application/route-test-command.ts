import type { DistributionConfigurationStorePort } from "../domain/distribution-ports.js";
import type { DistributionRuntimeStateStorePort } from "../domain/distribution-runtime-ports.js";
import type { PlatformSurfaceStorePort } from "../domain/platform-surface-ports.js";
import type { ExecutableRouteTestKey, RouteTestEvidenceStorePort } from "../domain/route-test-ports.js";
import type { RouteTestCommandCapability, RouteTestCommandPort, RouteTestCommandResult } from "../domain/route-test-command-ports.js";
import { RouteTestExecutionService } from "./route-test-execution.js";
import type { SafeObserverRouteTestRunner } from "../adapters/runtime/safe-route-test-runner.js";

export class PersistingRouteTestCommandService implements RouteTestCommandPort {
  private readonly execution:RouteTestExecutionService;
  constructor(
    evidence:RouteTestEvidenceStorePort,
    private readonly runner:SafeObserverRouteTestRunner,
    private readonly config:DistributionConfigurationStorePort,
    private readonly runtime:DistributionRuntimeStateStorePort,
    private readonly surfaces:PlatformSurfaceStorePort,
    private readonly releaseSha:string
  ){
    if(!releaseSha.trim())throw new Error("Route test commands require a release SHA");
    this.execution=new RouteTestExecutionService(evidence,runner);
  }

  capabilities(routeId:string):readonly RouteTestCommandCapability[]{return this.runner.capabilities(routeId);}

  async run(routeId:string,testKey:ExecutableRouteTestKey,now:string):Promise<RouteTestCommandResult>{
    const capability=this.capabilities(routeId).find(item=>item.testKey===testKey);
    if(!capability?.executable)throw new Error(capability?.reason??`Route test ${testKey} is unavailable`);
    const evidence=await this.execution.run(routeId,testKey,this.releaseSha,now);
    const route=this.config.load().config.routes.find(item=>item.routeId===routeId);
    if(!route)throw new Error(`Route ${routeId} disappeared after route test`);
    const surface=this.surfaces.latestContract(route.accountId,route.postingProfileId);
    const readiness=this.execution.readiness(routeId,{
      releaseSha:this.releaseSha,
      ...(surface?{surfaceRecordedAt:surface.recordedAt,surfaceContractId:surface.contract.contractId}:{})
    });
    this.runtime.putRouteTestReadiness(readiness,new Date(now).toISOString());
    return{evidence,readiness};
  }
}
