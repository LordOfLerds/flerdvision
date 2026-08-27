import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { WorkspaceDistributionRuntime } from "../adapters/runtime/workspace-distribution-runtime.js";
import { businessDateForInstant } from "../domain/scheduling.js";

function value(argv:readonly string[],name:string):string|undefined{const i=argv.indexOf(name);return i>=0?argv[i+1]:undefined;}
function required(name:string,input:string|undefined):string{const v=input?.trim();if(!v)throw new Error(`${name} is required`);return v;}

async function main():Promise<void>{
  if(process.env.ALLOW_FINAL_PUBLISH==="true")throw new Error("planning-only runtime refuses to start while ALLOW_FINAL_PUBLISH=true");
  const argv=process.argv.slice(2);
  const runtimeRoot=resolve(value(argv,"--runtime-root")??process.env.FLERDVISION_RUNTIME_ROOT??"runtime");
  const workspaceId=required("--workspace-id",value(argv,"--workspace-id")??process.env.FLERDVISION_WORKSPACE_ID);
  const explicitBusinessDate=value(argv,"--business-date");
  const timezone=value(argv,"--timezone")??process.env.FLERDVISION_TIMEZONE??"Europe/Vienna";
  const watchRaw=value(argv,"--watch-seconds");
  const watchSeconds=watchRaw===undefined?null:Number(watchRaw);
  if(watchSeconds!==null&&(!Number.isFinite(watchSeconds)||watchSeconds<30))throw new Error("--watch-seconds must be at least 30 seconds");

  const runtime=new WorkspaceDistributionRuntime({runtimeRoot,workspaceId});
  let stopping=false;
  process.on("SIGINT",()=>{stopping=true;});
  process.on("SIGTERM",()=>{stopping=true;});
  try{
    do{
      const now=new Date().toISOString();
      const businessDate=explicitBusinessDate??businessDateForInstant(now,timezone);
      const source=await runtime.source.scan(now);
      const plan=await runtime.planner.ensureDailyPlan(businessDate,now);
      const intents=await runtime.intents.ensureIntents(plan,now);
      console.log(JSON.stringify({
        mode:"PLANNING_ONLY",
        workspaceId,
        now,
        businessDate,
        source,
        plan:{planId:plan.planId,deliveries:plan.deliveries.length,gaps:plan.gaps.length,backlog:plan.backlog.length},
        intents
      }));
      if(watchSeconds===null||stopping)break;
      await sleep(watchSeconds*1000);
    }while(!stopping);
  }finally{runtime.close();}
}

main().catch((error)=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});
