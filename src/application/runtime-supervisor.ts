import type {
  RuntimeCycleLeasePort,
  RuntimeCycleReportStorePort,
  RuntimeDispositionPort,
  RuntimeDueExecutionPort,
  RuntimeIntentMaterializerPort,
  RuntimeOperationsPort,
  RuntimePlannerPort,
  RuntimeReconciliationPort,
  RuntimeSourceScanPort
} from "../domain/runtime-supervisor-ports.js";

export type RuntimePhase = "SOURCE_SCAN" | "PLAN" | "INTENTS" | "DUE_EXECUTION" | "RECONCILIATION" | "DISPOSITION" | "OPERATIONS";
export interface RuntimePhaseResult { phase: RuntimePhase; status: "PASS" | "FAIL" | "SKIPPED"; summary: string; }
export interface RuntimeCycleReport {
  cycleId: string;
  ownerId: string;
  startedAt: string;
  finishedAt: string;
  businessDate: string;
  phases: readonly RuntimePhaseResult[];
  healthy: boolean;
}

export interface RuntimeSupervisorPorts {
  lease: RuntimeCycleLeasePort;
  source: RuntimeSourceScanPort;
  planner: RuntimePlannerPort;
  intents: RuntimeIntentMaterializerPort;
  due: RuntimeDueExecutionPort;
  reconciliation: RuntimeReconciliationPort;
  disposition: RuntimeDispositionPort;
  operations: RuntimeOperationsPort;
  reports: RuntimeCycleReportStorePort;
}

function cycleId(ownerId:string,now:string):string{return `runtime-cycle:${ownerId}:${new Date(now).getTime().toString(36)}`;}
function errorText(error:unknown):string{return error instanceof Error?error.message:String(error);}

export class RuntimeSupervisor {
  constructor(
    private readonly ports:RuntimeSupervisorPorts,
    private readonly ownerId:string,
    private readonly clock:()=>string=()=>new Date().toISOString()
  ){}

  async runCycle(now:string,businessDate:string):Promise<RuntimeCycleReport>{
    const startedAt=new Date(now).toISOString();
    const lease=this.ports.lease.acquire(this.ownerId,startedAt);
    const phases:RuntimePhaseResult[]=[];
    let sourceSafe=true;
    let plan:Awaited<ReturnType<RuntimePlannerPort["ensureDailyPlan"]>>|undefined;
    const heartbeat=():void=>{lease.heartbeat?.(this.clock());};
    const run=async<T>(phase:RuntimePhase,fn:()=>Promise<T>,summary:(value:T)=>string):Promise<T|undefined>=>{
      let value:T|undefined;
      try{value=await fn();phases.push({phase,status:"PASS",summary:summary(value)});}
      catch(error){phases.push({phase,status:"FAIL",summary:errorText(error)});}
      heartbeat();
      return value;
    };
    try{
      const source=await run("SOURCE_SCAN",()=>this.ports.source.scan(startedAt),(r)=>`${r.observed} observed · ${r.ready} ready · ${r.stabilizing} stabilizing · ${r.blocked} blocked`);
      if(!source)sourceSafe=false;
      if(sourceSafe){
        plan=await run("PLAN",()=>this.ports.planner.ensureDailyPlan(businessDate,startedAt),(p)=>`${p.deliveries.length} deliveries · ${p.gaps.length} gaps · ${p.backlog.length} backlog`);
        if(plan)await run("INTENTS",()=>this.ports.intents.ensureIntents(plan!,startedAt),(r)=>`${r.created} created · ${r.existing} existing · ${r.blocked} blocked${r.blockedReasons?.length?` · ${r.blockedReasons.join(" | ")}`:""}`);
        else { phases.push({phase:"INTENTS",status:"SKIPPED",summary:"DailyPlan unavailable"}); heartbeat(); }
      }else{
        phases.push({phase:"PLAN",status:"SKIPPED",summary:"Source scan failed; no new planning from untrusted source state"}); heartbeat();
        phases.push({phase:"INTENTS",status:"SKIPPED",summary:"Planning skipped"}); heartbeat();
      }
      await run("DUE_EXECUTION",()=>this.ports.due.runDue(startedAt),(r)=>`${r.claimed} claimed · ${r.prepared} prepared · ${r.verified} verified · ${r.uncertain} uncertain · ${r.blocked} blocked · ${r.waived} waived${r.frozen!==undefined?` · ${r.frozen} held by live freeze`:""}`);
      await run("RECONCILIATION",()=>this.ports.reconciliation.reconcile(startedAt),(r)=>`${r.inspected} inspected · ${r.verified} verified · ${r.safeToRetry} safe-to-retry · ${r.stillUncertain} uncertain`);
      await run("DISPOSITION",()=>this.ports.disposition.applyEligible(startedAt),(r)=>`${r.inspected} inspected · ${r.completed} completed · ${r.externalMutations} external mutations · ${r.manualReview} manual review`);
      await run("OPERATIONS",()=>this.ports.operations.projectAndNotify(startedAt),(r)=>`${r.incidentsCreated} incidents · ${r.notificationsEnqueued} notifications`);
      const finishedAt=new Date(this.clock()).toISOString();
      const report:RuntimeCycleReport={cycleId:cycleId(this.ownerId,startedAt),ownerId:this.ownerId,startedAt,finishedAt,businessDate,phases,healthy:phases.every((p)=>p.status!=="FAIL")};
      this.ports.reports.record(report);
      return report;
    }finally{lease.release(this.clock());}
  }
}
