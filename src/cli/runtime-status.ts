import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { workspaceRuntimeLayout } from "../application/workspaces.js";
import { businessDateForInstant } from "../domain/scheduling.js";
import { JsonDistributionConfigurationStore } from "../adapters/distribution/json-config-store.js";
import { SqliteControlCenterRuntimeAdapter } from "../adapters/control/sqlite-control-center-runtime.js";
import { SqliteControlPlaneStore } from "../adapters/storage/sqlite.js";

function arg(name:string):string|undefined{const index=process.argv.indexOf(name);return index>=0?process.argv[index+1]:undefined;}
function required(name:string,value:string|undefined):string{const normalized=value?.trim();if(!normalized)throw new Error(`${name} is required`);return normalized;}

async function main():Promise<void>{
  const runtimeRoot=resolve(arg("--runtime-root")??process.env.FLERDVISION_RUNTIME_ROOT??"runtime"),workspaceId=required("--workspace-id",arg("--workspace-id")??process.env.FLERDVISION_WORKSPACE_ID),timeZone=arg("--timezone")??process.env.FLERDVISION_TIMEZONE??"Europe/Vienna",now=new Date(arg("--now")??new Date().toISOString()).toISOString();
  const layout=workspaceRuntimeLayout(runtimeRoot,workspaceId);if(!existsSync(layout.databasePath))throw new Error(`Workspace database does not exist: ${layout.databasePath}`);
  const config=new JsonDistributionConfigurationStore(resolve(layout.configDir,"distribution.json"));
  const runtime=new SqliteControlCenterRuntimeAdapter(layout.databasePath,config,workspaceId),control=new SqliteControlPlaneStore(layout.databasePath);
  try{
    const businessDate=businessDateForInstant(now,timeZone),snapshot=await runtime.snapshot(businessDate),assetStates=Object.fromEntries(["OBSERVED","STABILIZING","READY","BLOCKED","COMPLETE"].map(state=>[state,snapshot.assets.filter(asset=>asset.state===state).length]));
    const cycles=snapshot.runtimeCycles??[],latestCycle=cycles[0];
    console.log(JSON.stringify({
      checkedAt:now,workspaceId,businessDate,
      controlPlane:control.summary(now),
      dailyPlan:{planId:snapshot.plan.planId,generatedAt:snapshot.plan.generatedAt,deliveries:snapshot.plan.deliveries.length,gaps:snapshot.plan.gaps.length,backlog:snapshot.plan.backlog.length},
      assets:{total:snapshot.assets.length,states:assetStates},
      sourcePolling:snapshot.sourcePolling??null,
      runtimeCycles:{available:cycles.length,latest:latestCycle??null},
      incidents:{total:(snapshot.incidents??[]).length,open:(snapshot.incidents??[]).filter(incident=>incident.status==="OPEN"||incident.status==="ACKNOWLEDGED").length}
    },null,2));
  }finally{control.close();runtime.close();}
}

main().catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});
