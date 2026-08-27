import type { DistributionConfigurationStorePort } from "../domain/distribution-ports.js";
import type { SourcePollingRuntimeState, SourcePollingStateStorePort } from "../domain/source-poll-state-ports.js";
import type { RuntimeSourceScanPort, RuntimeSourceScanReport } from "../domain/runtime-supervisor-ports.js";
import { DEFAULT_DISTRIBUTION_RUNTIME_POLICY, decideSourcePoll, type SourcePollingPolicy, type SourcePollTrigger } from "../domain/distribution-operations.js";

export interface RuntimeSourcePollingSnapshot {
  lastPollAt?: string;
  nextPollAt?: string;
  lastTrigger?: SourcePollTrigger;
  skippedCycles: number;
  updatedAt?:string;
}

/** Runtime cycles may run often; actual provider discovery follows one shared workspace poll state. */
export class PollingRuntimeSourceScanAdapter implements RuntimeSourceScanPort {
  private memory:SourcePollingRuntimeState={skippedCycles:0,updatedAt:new Date(0).toISOString()};

  constructor(
    private readonly inner: RuntimeSourceScanPort,
    private readonly config: DistributionConfigurationStorePort,
    private readonly state?:SourcePollingStateStorePort
  ) {}

  private policy():SourcePollingPolicy{return this.config.load().runtimePolicy?.sourcePolling ?? DEFAULT_DISTRIBUTION_RUNTIME_POLICY.sourcePolling;}
  private current():SourcePollingRuntimeState{return this.state?.get()??this.memory;}
  private persist(next:SourcePollingRuntimeState):SourcePollingRuntimeState{
    const stored=this.state?.put(next)??next;this.memory=stored;return stored;
  }

  async scan(now: string): Promise<RuntimeSourceScanReport> {
    const timestamp=new Date(now).toISOString(),policy=this.policy(),current=this.current();
    const decision=decideSourcePoll({now:timestamp,...(current.lastPollAt?{lastPollAt:current.lastPollAt}:{}),policy});
    if(!decision.due){
      this.persist({...current,nextPollAt:decision.nextPollAt,skippedCycles:current.skippedCycles+1,updatedAt:timestamp});
      return{observed:0,ready:0,stabilizing:0,blocked:0};
    }
    return await this.execute(timestamp,decision.trigger,policy,current.skippedCycles);
  }

  async forceScan(now:string,trigger:Exclude<SourcePollTrigger,"INTERVAL">="MANUAL"):Promise<RuntimeSourceScanReport>{
    const timestamp=new Date(now).toISOString(),current=this.current();
    return await this.execute(timestamp,trigger,this.policy(),current.skippedCycles);
  }

  private async execute(timestamp:string,trigger:SourcePollTrigger,policy:SourcePollingPolicy,skippedCycles:number):Promise<RuntimeSourceScanReport>{
    const report=await this.inner.scan(timestamp);
    const nextPollAt=decideSourcePoll({now:timestamp,lastPollAt:timestamp,policy}).nextPollAt;
    this.persist({lastPollAt:timestamp,nextPollAt,lastTrigger:trigger,skippedCycles,updatedAt:timestamp});
    return report;
  }

  snapshot():RuntimeSourcePollingSnapshot{
    const current=this.current();
    return{...(current.lastPollAt?{lastPollAt:current.lastPollAt}:{}),...(current.nextPollAt?{nextPollAt:current.nextPollAt}:{}),...(current.lastTrigger?{lastTrigger:current.lastTrigger}:{}),skippedCycles:current.skippedCycles,updatedAt:current.updatedAt};
  }
}
