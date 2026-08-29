import type { DailyPlan } from "./distribution.js";

export interface RuntimeCycleLease {
  /** Optional for compatibility fakes; concrete host lease adapters heartbeat between phases. */
  heartbeat?(now:string):void;
  release(now?:string):void;
}
export interface RuntimeCycleLeasePort { acquire(ownerId: string, now: string): RuntimeCycleLease; }
export interface RuntimeSourceScanReport { observed: number; ready: number; stabilizing: number; blocked: number; }
export interface RuntimeSourceScanPort { scan(now: string): Promise<RuntimeSourceScanReport>; }
export interface RuntimePlannerPort { ensureDailyPlan(businessDate: string, now: string): Promise<DailyPlan>; }
export interface RuntimeIntentMaterializerPort { ensureIntents(plan: DailyPlan, now: string): Promise<{ created: number; existing: number; blocked: number; blockedReasons?: readonly string[] }>; }
export interface RuntimeDueExecutionReport { claimed: number; prepared: number; verified: number; uncertain: number; blocked: number; frozen?: number; }
export interface RuntimeDueExecutionPort { runDue(now: string): Promise<RuntimeDueExecutionReport>; }
export interface RuntimeReconciliationReport { inspected: number; verified: number; safeToRetry: number; stillUncertain: number; }
export interface RuntimeReconciliationPort { reconcile(now: string): Promise<RuntimeReconciliationReport>; }
export interface RuntimeDispositionReport { inspected: number; completed: number; externalMutations: number; manualReview: number; }
export interface RuntimeDispositionPort { applyEligible(now: string): Promise<RuntimeDispositionReport>; }
export interface RuntimeOperationsReport { incidentsCreated: number; notificationsEnqueued: number; }
export interface RuntimeOperationsPort { projectAndNotify(now: string): Promise<RuntimeOperationsReport>; }
export interface RuntimeCycleReportStorePort { record(report: import("../application/runtime-supervisor.js").RuntimeCycleReport): void; }
