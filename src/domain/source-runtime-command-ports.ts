import type { RuntimeSourceScanReport } from "./runtime-supervisor-ports.js";

export interface SourceRuntimeScanReport extends RuntimeSourceScanReport {
  trigger:"MANUAL";
  scannedAt:string;
}

export interface SourceRuntimeCommandPort {
  scanNow(now:string):Promise<SourceRuntimeScanReport>;
}
