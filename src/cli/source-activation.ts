import { resolve } from "node:path";
import { WorkspaceDistributionRuntime } from "../adapters/runtime/workspace-distribution-runtime.js";

function value(argv:readonly string[],name:string):string|undefined{const i=argv.indexOf(name);return i>=0?argv[i+1]:undefined;}
function required(name:string,input:string|undefined):string{const v=input?.trim();if(!v)throw new Error(`${name} is required`);return v;}

async function main():Promise<void>{
  const argv=process.argv.slice(2);
  const command=argv[0];
  if(command!=="status"&&command!=="capture")throw new Error("Usage: source-activation <status|capture> --workspace-id <id> --lane-id <id> [--runtime-root runtime]");
  const runtimeRoot=resolve(value(argv,"--runtime-root")??process.env.FLERDVISION_RUNTIME_ROOT??"runtime");
  const workspaceId=required("--workspace-id",value(argv,"--workspace-id")??process.env.FLERDVISION_WORKSPACE_ID);
  const laneId=required("--lane-id",value(argv,"--lane-id"));
  const runtime=new WorkspaceDistributionRuntime({runtimeRoot,workspaceId});
  try{
    const status=command==="capture"
      ? await runtime.activation.captureBaseline(laneId,new Date().toISOString())
      : runtime.activation.status(laneId);
    console.log(JSON.stringify(status,null,2));
    if(status.state==="MISCONFIGURED"||status.state==="MISSING_BASELINE")process.exitCode=2;
  }finally{runtime.close();}
}

main().catch((error)=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});
