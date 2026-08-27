import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { ensureWorkspaceCalibrationTemplates, workspaceRuntimeLayout } from "../application/workspaces.js";
import { PrivateE2EHttpServer } from "../adapters/control/private-e2e-http.js";
import { ProductControlCenterHttpServer } from "../adapters/control/product-control-center-http.js";
import { SurfaceCalibrationHttpServer } from "../adapters/control/surface-calibration-http.js";
import { SqliteControlCenterRuntimeAdapter } from "../adapters/control/sqlite-control-center-runtime.js";
import { JsonDistributionConfigurationStore } from "../adapters/distribution/json-config-store.js";
import { WorkspaceChannelOperatorCommands } from "../adapters/runtime/workspace-channel-operator.js";
import { WorkspaceEffectiveConfigurationCommands } from "../adapters/runtime/workspace-effective-config-commands.js";
import { WorkspaceIncidentOperatorCommands } from "../adapters/runtime/workspace-incident-operator.js";
import { WorkspacePrivateE2ECommands } from "../adapters/runtime/workspace-private-e2e.js";
import { WorkspaceRouteTestCommands } from "../adapters/runtime/workspace-route-tests.js";
import { WorkspaceSourceActivationCommands } from "../adapters/runtime/workspace-source-activation.js";
import { WorkspaceSourceRuntimeCommands } from "../adapters/runtime/workspace-source-runtime-commands.js";
import { WorkspaceSurfaceCalibrationCommands } from "../adapters/runtime/workspace-surface-calibration.js";

interface Args {runtimeRoot:string;workspaceId:string;password:string;username:string;host:string;port:number;calibrationPort:number;privateE2EPort:number;releaseSha?:string;}
function value(argv:readonly string[],name:string):string|undefined{const index=argv.indexOf(name);return index>=0?argv[index+1]:undefined;}
function required(name:string,value:string|undefined):string{const normalized=value?.trim();if(!normalized)throw new Error(`${name} is required`);return normalized;}
function tcpPort(raw:string,label:string):number{const port=Number(raw);if(!Number.isInteger(port)||port<1||port>65535)throw new Error(`${label} must be a valid TCP port`);return port;}
function accountIds(raw:string|undefined):Set<string>{return new Set((raw??"").split(",").map(item=>item.trim()).filter(Boolean));}
function parse(argv:readonly string[]):Args{
  const port=tcpPort(value(argv,"--port")??process.env.FLERDVISION_CONTROL_PORT??"8790","--port"),calibrationPort=tcpPort(value(argv,"--calibration-port")??process.env.FLERDVISION_CALIBRATION_PORT??"8791","--calibration-port"),privateE2EPort=tcpPort(value(argv,"--private-e2e-port")??process.env.FLERDVISION_PRIVATE_E2E_PORT??"8792","--private-e2e-port");
  if(new Set([port,calibrationPort,privateE2EPort]).size!==3)throw new Error("Control Center, Calibration UI and Private E2E UI ports must all differ");
  const releaseSha=(value(argv,"--release-sha")??process.env.FLERDVISION_RELEASE_SHA)?.trim();
  return{runtimeRoot:resolve(value(argv,"--runtime-root")??process.env.FLERDVISION_RUNTIME_ROOT??"runtime"),workspaceId:required("--workspace-id",value(argv,"--workspace-id")??process.env.FLERDVISION_WORKSPACE_ID),password:required("--password / FLERDVISION_CONTROL_PASSWORD",value(argv,"--password")??process.env.FLERDVISION_CONTROL_PASSWORD),username:value(argv,"--username")??process.env.FLERDVISION_CONTROL_USERNAME??"flerdvision",host:value(argv,"--host")??process.env.FLERDVISION_CONTROL_HOST??"127.0.0.1",port,calibrationPort,privateE2EPort,...(releaseSha?{releaseSha}:{})};
}

async function main():Promise<void>{
  const args=parse(process.argv.slice(2));
  if(process.env.ALLOW_FINAL_PUBLISH==="true")throw new Error("Control Center refuses to start while ALLOW_FINAL_PUBLISH=true during the R0 live freeze");
  const layout=workspaceRuntimeLayout(args.runtimeRoot,args.workspaceId);if(!existsSync(layout.workspaceRoot)||!statSync(layout.workspaceRoot).isDirectory())throw new Error(`Workspace runtime does not exist: ${layout.workspaceRoot}. Complete setup first.`);
  ensureWorkspaceCalibrationTemplates(layout.configDir);
  const config=new JsonDistributionConfigurationStore(resolve(layout.configDir,"distribution.json")),runtime=new SqliteControlCenterRuntimeAdapter(layout.databasePath,config,args.workspaceId),sourceActivation=new WorkspaceSourceActivationCommands({runtimeRoot:args.runtimeRoot,workspaceId:args.workspaceId}),sourceRuntime=new WorkspaceSourceRuntimeCommands({runtimeRoot:args.runtimeRoot,workspaceId:args.workspaceId}),effectiveChanges=new WorkspaceEffectiveConfigurationCommands({runtimeRoot:args.runtimeRoot,workspaceId:args.workspaceId}),channelOperator=new WorkspaceChannelOperatorCommands({runtimeRoot:args.runtimeRoot,workspaceId:args.workspaceId}),incidentOperator=new WorkspaceIncidentOperatorCommands(args.runtimeRoot,args.workspaceId,args.username);
  const chromiumExecutablePath=process.env.CHROMIUM_EXECUTABLE_PATH,surfaceCalibration=new WorkspaceSurfaceCalibrationCommands({runtimeRoot:args.runtimeRoot,workspaceId:args.workspaceId,...(chromiumExecutablePath?{chromiumExecutablePath}:{})}),routeTests=args.releaseSha?new WorkspaceRouteTestCommands({runtimeRoot:args.runtimeRoot,workspaceId:args.workspaceId,releaseSha:args.releaseSha}):undefined;
  const privateE2EAccounts=accountIds(process.env.FLERDVISION_PRIVATE_E2E_ACCOUNT_IDS),privateE2E=args.releaseSha?new WorkspacePrivateE2ECommands({runtimeRoot:args.runtimeRoot,workspaceId:args.workspaceId,releaseSha:args.releaseSha,allowedAccountIds:privateE2EAccounts,operatorId:args.username,...(chromiumExecutablePath?{chromiumExecutablePath}:{})}):undefined;
  const server=new ProductControlCenterHttpServer(config,runtime,{password:args.password,username:args.username,host:args.host,port:args.port,sourceActivation,sourceRuntime,effectiveChanges,channelOperator,incidentOperator,...(routeTests?{routeTests}:{})}),controlCenterBaseUrl=`http://${args.host}:${args.port}`;
  const calibrationServer=new SurfaceCalibrationHttpServer(config,surfaceCalibration,{password:args.password,username:args.username,host:args.host,port:args.calibrationPort,controlCenterBaseUrl});
  const privateE2EServer=privateE2E?new PrivateE2EHttpServer(privateE2E,{password:args.password,username:args.username,host:args.host,port:args.privateE2EPort,controlCenterBaseUrl,allowedAccountsConfigured:privateE2EAccounts.size>0}):undefined;
  let resourcesClosed=false;
  const closeResources=async()=>{if(resourcesClosed)return;resourcesClosed=true;routeTests?.close();if(privateE2E)await privateE2E.close();await surfaceCalibration.close();incidentOperator.close();await channelOperator.close();effectiveChanges.close();sourceRuntime.close();sourceActivation.close();runtime.close();};
  let bound:{host:string;port:number}|undefined,calibrationBound:{host:string;port:number}|undefined,privateE2EBound:{host:string;port:number}|undefined;
  try{bound=await server.start();calibrationBound=await calibrationServer.start();if(privateE2EServer)privateE2EBound=await privateE2EServer.start();}
  catch(error){await Promise.allSettled([server.stop(),calibrationServer.stop(),privateE2EServer?.stop()??Promise.resolve()]);await closeResources();throw error;}
  console.log(`Flerdvision Control Center: http://${bound.host}:${bound.port}/today`);console.log(`Surface Calibration: http://${calibrationBound.host}:${calibrationBound.port}/`);console.log(privateE2EBound?`Private E2E: http://${privateE2EBound.host}:${privateE2EBound.port}/ · allowlisted accounts=${privateE2EAccounts.size}`:"Private E2E: disabled; set exact FLERDVISION_RELEASE_SHA to enable the release-scoped operator flow");console.log(`Workspace: ${args.workspaceId}`);console.log(`Route test commands: ${routeTests?`enabled for release ${args.releaseSha}`:"read-only; set FLERDVISION_RELEASE_SHA to enable safe route tests"}`);
  let stopping=false;const stop=()=>{if(stopping)return;stopping=true;void (async()=>{await Promise.allSettled([server.stop(),calibrationServer.stop(),privateE2EServer?.stop()??Promise.resolve()]);await closeResources();})();};process.on("SIGINT",stop);process.on("SIGTERM",stop);
}
main().catch((error)=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});
