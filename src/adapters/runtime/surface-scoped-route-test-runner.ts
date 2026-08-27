import type { DistributionConfigurationStorePort } from "../../domain/distribution-ports.js";
import type { PlatformSurfaceStorePort } from "../../domain/platform-surface-ports.js";
import type { CapabilityAwareRouteTestExecutionAdapterPort, RouteTestCommandCapability } from "../../domain/route-test-command-ports.js";
import type { ExecutableRouteTestKey, RouteTestExecutionResult } from "../../domain/route-test-ports.js";

const CONTRACT_BOUND=new Set<ExecutableRouteTestKey>(["SURFACE","PREPARE_ONLY","VERIFICATION"]);

/** Freezes the surface contract identity at command start so recalibration cannot steal in-flight evidence. */
export class SurfaceScopedRouteTestRunner implements CapabilityAwareRouteTestExecutionAdapterPort {
  constructor(private readonly inner:CapabilityAwareRouteTestExecutionAdapterPort,private readonly config:DistributionConfigurationStorePort,private readonly surfaces:PlatformSurfaceStorePort){}
  capabilities(routeId:string):readonly RouteTestCommandCapability[]{return this.inner.capabilities(routeId);}
  private contractId(routeId:string):string|undefined{const route=this.config.load().config.routes.find(item=>item.routeId===routeId);if(!route)return undefined;return this.surfaces.latestContract(route.accountId,route.postingProfileId)?.contract.contractId;}
  async run(routeId:string,testKey:ExecutableRouteTestKey,checkedAt?:string):Promise<RouteTestExecutionResult>{
    const surfaceContractId=CONTRACT_BOUND.has(testKey)?this.contractId(routeId):undefined,result=await this.inner.run(routeId,testKey,checkedAt);
    if(!CONTRACT_BOUND.has(testKey))return result;
    const resolved=result.surfaceContractId??surfaceContractId;
    if(!resolved)return result;
    return{...result,surfaceContractId:resolved};
  }
}
