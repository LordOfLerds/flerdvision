import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { WorkspaceDistributionRuntime } from "../adapters/runtime/workspace-distribution-runtime.js";
import { businessDateForInstant } from "../domain/scheduling.js";

function value(argv:readonly string[],name:string):string|undefined{const i=argv.indexOf(name);return i>=0?argv[i+1]:undefined;}
function required(name:string,input:string|undefined):string{const v=input?.trim();if(!v)throw new Error(`${name} is required`);return v;}
function channelKeys(raw:string|undefined):string[]{return [...new Set((raw??"").split(",").map(item=>item.trim()).filter(Boolean))];}

async function main():Promise<void>{
  if(process.env.ALLOW_FINAL_PUBLISH==="true")throw new Error("R0 live freeze: runtime refuses ALLOW_FINAL_PUBLISH=true");
  const argv=process.argv.slice(2);
  const runtimeRoot=resolve(value(argv,"--runtime-root")??process.env.FLERDVISION_RUNTIME_ROOT??"runtime");
  const workspaceId=required("--workspace-id",value(argv,"--workspace-id")??process.env.FLERDVISION_WORKSPACE_ID);
  const ownerId=value(argv,"--owner-id")??`${workspaceId}:runtime`;
  const timeZone=value(argv,"--timezone")??process.env.FLERDVISION_TIMEZONE??"Europe/Vienna";
  const daemon=argv.includes("--daemon");
  const intervalRaw=value(argv,"--interval-seconds");
  const intervalSeconds=intervalRaw===undefined?(daemon?60:null):Number(intervalRaw);
  if(intervalSeconds!==null&&(!Number.isFinite(intervalSeconds)||intervalSeconds<30))throw new Error("--interval-seconds must be at least 30");
  const notificationChannelKeys=channelKeys(value(argv,"--notification-channels")??process.env.FLERDVISION_NOTIFICATION_CHANNELS);
  const uiBaseUrl=value(argv,"--ui-base-url")??process.env.FLERDVISION_UI_BASE_URL;

  // intervalSeconds is the cheap control-cycle cadence. Actual Drive/folder polling is independently
  // gated by runtimePolicy.sourcePolling inside WorkspaceDistributionRuntime.
  const runtime=new WorkspaceDistributionRuntime({
    runtimeRoot,
    workspaceId,
    timeZone,
    notificationChannelKeys,
    ...(uiBaseUrl?{uiBaseUrl}:{})
  });
  let stopping=false;
  process.on("SIGINT",()=>{stopping=true;});
  process.on("SIGTERM",()=>{stopping=true;});
  try{
    do{
      const now=new Date().toISOString();
      const businessDate=businessDateForInstant(now,timeZone);
      const report=await runtime.supervisor(ownerId).runCycle(now,businessDate);
      console.log(JSON.stringify({mode:"R0_LIVE_FREEZE",workspaceId,sourcePolling:runtime.source.snapshot(),report}));
      if(intervalSeconds===null||stopping)break;
      await sleep(intervalSeconds*1000);
    }while(!stopping);
  }finally{runtime.close();}
}

main().catch((error)=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});
