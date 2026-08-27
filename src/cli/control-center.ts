import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { workspaceRuntimeLayout } from "../application/workspaces.js";
import { ProductControlCenterHttpServer } from "../adapters/control/product-control-center-http.js";
import { SqliteControlCenterRuntimeAdapter } from "../adapters/control/sqlite-control-center-runtime.js";
import { JsonDistributionConfigurationStore } from "../adapters/distribution/json-config-store.js";
import { WorkspaceRouteTestCommands } from "../adapters/runtime/workspace-route-tests.js";
import { WorkspaceSourceActivationCommands } from "../adapters/runtime/workspace-source-activation.js";
import { WorkspaceSourceRuntimeCommands } from "../adapters/runtime/workspace-source-runtime-commands.js";

interface Args {
  runtimeRoot:string;
  workspaceId:string;
  password:string;
  username:string;
  host:string;
  port:number;
  releaseSha?:string;
}

function value(argv:readonly string[],name:string):string|undefined{const index=argv.indexOf(name);return index>=0?argv[index+1]:undefined;}
function required(name:string,value:string|undefined):string{const normalized=value?.trim();if(!normalized)throw new Error(`${name} is required`);return normalized;}
function parse(argv:readonly string[]):Args{
  const port=Number(value(argv,"--port")??process.env.FLERDVISION_CONTROL_PORT??8790);
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error("--port must be a valid TCP port");
  const releaseSha=(value(argv,"--release-sha")??process.env.FLERDVISION_RELEASE_SHA)?.trim();
  return{
    runtimeRoot:resolve(value(argv,"--runtime-root")??process.env.FLERDVISION_RUNTIME_ROOT??"runtime"),
    workspaceId:required("--workspace-id",value(argv,"--workspace-id")??process.env.FLERDVISION_WORKSPACE_ID),
    password:required("--password / FLERDVISION_CONTROL_PASSWORD",value(argv,"--password")??process.env.FLERDVISION_CONTROL_PASSWORD),
    username:value(argv,"--username")??process.env.FLERDVISION_CONTROL_USERNAME??"flerdvision",
    host:value(argv,"--host")??process.env.FLERDVISION_CONTROL_HOST??"127.0.0.1",
    port,
    ...(releaseSha?{releaseSha}:{})
  };
}

async function main():Promise<void>{
  const args=parse(process.argv.slice(2));
  if(process.env.ALLOW_FINAL_PUBLISH==="true")throw new Error("Control Center refuses to start while ALLOW_FINAL_PUBLISH=true during the R0 live freeze");
  const layout=workspaceRuntimeLayout(args.runtimeRoot,args.workspaceId);
  if(!existsSync(layout.workspaceRoot)||!statSync(layout.workspaceRoot).isDirectory())throw new Error(`Workspace runtime does not exist: ${layout.workspaceRoot}. Complete setup first.`);

  const config=new JsonDistributionConfigurationStore(resolve(layout.configDir,"distribution.json"));
  const runtime=new SqliteControlCenterRuntimeAdapter(layout.databasePath,config,args.workspaceId);
  const sourceActivation=new WorkspaceSourceActivationCommands({runtimeRoot:args.runtimeRoot,workspaceId:args.workspaceId});
  const sourceRuntime=new WorkspaceSourceRuntimeCommands({runtimeRoot:args.runtimeRoot,workspaceId:args.workspaceId});
  const routeTests=args.releaseSha?new WorkspaceRouteTestCommands({runtimeRoot:args.runtimeRoot,workspaceId:args.workspaceId,releaseSha:args.releaseSha}):undefined;
  const server=new ProductControlCenterHttpServer(config,runtime,{
    password:args.password,
    username:args.username,
    host:args.host,
    port:args.port,
    sourceActivation,
    sourceRuntime,
    ...(routeTests?{routeTests}:{})
  });
  const bound=await server.start();
  console.log(`Flerdvision Control Center: http://${bound.host}:${bound.port}/today`);
  console.log(`Workspace: ${args.workspaceId}`);
  console.log(`Route test commands: ${routeTests?`enabled for release ${args.releaseSha}`:"read-only; set FLERDVISION_RELEASE_SHA to enable safe route tests"}`);
  const stop=()=>{void server.stop().finally(()=>{routeTests?.close();sourceRuntime.close();sourceActivation.close();runtime.close();});};
  process.on("SIGINT",stop);
  process.on("SIGTERM",stop);
}

main().catch((error)=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});
