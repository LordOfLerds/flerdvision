import type { DistributionConfigurationStorePort } from "../domain/distribution-ports.js";
import type { RuntimeSourceScanPort, RuntimeSourceScanReport } from "../domain/runtime-supervisor-ports.js";
import { DEFAULT_DISTRIBUTION_RUNTIME_POLICY, decideSourcePoll, type SourcePollTrigger } from "../domain/distribution-operations.js";

export interface RuntimeSourcePollingSnapshot {
  lastPollAt?: string;
  nextPollAt?: string;
  lastTrigger?: SourcePollTrigger;
  skippedCycles: number;
}

/**
 * Runtime cycles may run frequently for notifications/recovery. This adapter independently gates
 * expensive source discovery using the workspace's SourcePollingPolicy. A process restart is an
 * intentional STARTUP poll; duplicate source discovery is safe/idempotent in the ingress store.
 */
export class PollingRuntimeSourceScanAdapter implements RuntimeSourceScanPort {
  private lastPollAt: string | undefined;
  private nextPollAt: string | undefined;
  private lastTrigger: SourcePollTrigger | undefined;
  private skippedCycles = 0;

  constructor(
    private readonly inner: RuntimeSourceScanPort,
    private readonly config: DistributionConfigurationStorePort
  ) {}

  private policy(){return this.config.load().runtimePolicy?.sourcePolling ?? DEFAULT_DISTRIBUTION_RUNTIME_POLICY.sourcePolling;}

  async scan(now: string): Promise<RuntimeSourceScanReport> {
    const timestamp = new Date(now).toISOString(),policy=this.policy();
    const decision = decideSourcePoll({ now: timestamp, ...(this.lastPollAt ? { lastPollAt: this.lastPollAt } : {}), policy });
    this.nextPollAt = decision.nextPollAt;
    this.lastTrigger = decision.trigger;
    if (!decision.due) {
      this.skippedCycles += 1;
      return { observed: 0, ready: 0, stabilizing: 0, blocked: 0 };
    }
    return await this.execute(timestamp,decision.trigger,policy);
  }

  async forceScan(now:string,trigger:Exclude<SourcePollTrigger,"INTERVAL">="MANUAL"):Promise<RuntimeSourceScanReport>{
    const timestamp=new Date(now).toISOString(),policy=this.policy();
    return await this.execute(timestamp,trigger,policy);
  }

  private async execute(timestamp:string,trigger:SourcePollTrigger,policy:ReturnType<PollingRuntimeSourceScanAdapter["policy"]>):Promise<RuntimeSourceScanReport>{
    const report = await this.inner.scan(timestamp);
    this.lastPollAt = timestamp;
    this.lastTrigger=trigger;
    this.nextPollAt = decideSourcePoll({ now: timestamp, lastPollAt: timestamp, policy }).nextPollAt;
    return report;
  }

  snapshot(): RuntimeSourcePollingSnapshot {
    return {
      ...(this.lastPollAt ? { lastPollAt: this.lastPollAt } : {}),
      ...(this.nextPollAt ? { nextPollAt: this.nextPollAt } : {}),
      ...(this.lastTrigger ? { lastTrigger: this.lastTrigger } : {}),
      skippedCycles: this.skippedCycles
    };
  }
}
