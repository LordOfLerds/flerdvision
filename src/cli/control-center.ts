import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { workspaceRuntimeLayout } from "../application/workspaces.js";
import { ProductControlCenterHttpServer } from "../adapters/control/product-control-center-http.js";
import { SqliteControlCenterRuntimeAdapter } from "../adapters/control/sqlite-control-center-runtime.js";
import { JsonDistributionConfigurationStore } from "../adapters/distribution/json-config-store.js";

interface Args {
  runtimeRoot:string;
  workspaceId:string;
  password:string;
  username:string;
  host:string;
  port:number;
}

function value(argv:readonly string[],name:string):string|undefined{
  const index=argv.indexOf(name);
  return index>=0?argv[index+1]:undefined;
}
function required(name:string,value:string|undefined):string{
  const normalized=value?.trim();
  if(!normalized)throw new Error(`${name} is required`);
  return normalized;
}
function parse(argv:readonly string[]):Args{
  const port=Number(value(argv,"--port")??process.env.FLERDVISION_CONTROL_PORT??8790);
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error("--port must be a valid TCP port");
  return{
    runtimeRoot:resolve(value(argv,"--runtime-root")??process.env.FLERDVISION_RUNTIME_ROOT??"runtime"),
    workspaceId:required("--workspace-id",value(argv,"--workspace-id")??process.env.FLERDVISION_WORKSPACE_ID),
    password:required("--password / FLERDVISION_CONTROL_PASSWORD",value(argv,"--password")??process.env.FLERDVISION_CONTROL_PASSWORD),
    username:value(argv,"--username")??process.env.FLERDVISION_CONTROL_USERNAME??"flerdvision",
    host:value(argv,"--host")??process.env.FLERDVISION_CONTROL_HOST??"127.0.0.1",
    port
  };
}

async function main():Promise<void>{
  const args=parse(process.argv.slice(2));
  if(process.env.ALLOW_FINAL_PUBLISH==="true"){
    throw new Error("Control Center refuses to start while ALLOW_FINAL_PUBLISH=true during the R0 live freeze");
  }
  const layout=workspaceRuntimeLayout(args.runtimeRoot,args.workspaceId);
  if(!existsSync(layout.workspaceRoot)||!statSync(layout.workspaceRoot).isDirectory()){
    throw new Error(`Workspace runtime does not exist: ${layout.workspaceRoot}. Complete setup first.`);
  }
  const config=new JsonDistributionConfigurationStore(resolve(layout.configDir,"distribution.json"));
  const runtime=new SqliteControlCenterRuntimeAdapter(layout.databasePath,config,args.workspaceId);
  const server=new ProductControlCenterHttpServer(config,runtime,{
    password:args.password,
    username:args.username,
    host:args.host,
    port:args.port
  });
  const bound=await server.start();
  console.log(`Flerdvision Control Center: http://${bound.host}:${bound.port}/today`);
  console.log(`Workspace: ${args.workspaceId}`);
  const stop=()=>{void server.stop().finally(()=>runtime.close());};
  process.on("SIGINT",stop);
  process.on("SIGTERM",stop);
}

main().catch((error)=>{
  console.error(error instanceof Error?error.message:String(error));
  process.exitCode=1;
});
