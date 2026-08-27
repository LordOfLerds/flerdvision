import type { SourceRuntimeCommandPort, SourceRuntimeScanReport } from "../../domain/source-runtime-command-ports.js";
import { WorkspaceDistributionRuntime } from "./workspace-distribution-runtime.js";

export class WorkspaceSourceRuntimeCommands implements SourceRuntimeCommandPort {
  private readonly runtime:WorkspaceDistributionRuntime;
  private readonly ownerId:string;
  constructor(options:{runtimeRoot:string;workspaceId:string;env?:Record<string,string|undefined>}){
    this.runtime=new WorkspaceDistributionRuntime({runtimeRoot:options.runtimeRoot,workspaceId:options.workspaceId,...(options.env?{env:options.env}:{})});
    this.ownerId=`${options.workspaceId}:manual-source-scan`;
  }

  async scanNow(now:string):Promise<SourceRuntimeScanReport>{
    const timestamp=new Date(now).toISOString();
    const lease=this.runtime.lease.acquire(this.ownerId,timestamp);
    try{
      const report=await this.runtime.source.forceScan(timestamp,"MANUAL");
      return{...report,trigger:"MANUAL",scannedAt:timestamp};
    }finally{
      lease.release(timestamp);
    }
  }

  close():void{this.runtime.close();}
}
