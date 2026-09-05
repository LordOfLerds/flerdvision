import type { Actor } from "../domain/control-plane.js";
import type { IncidentStorePort } from "../domain/operations-ports.js";
import type { Incident } from "../domain/operations.js";
import type { RepairStorePort } from "../domain/repair-ports.js";
import type { RepairPolicyVerdict } from "../domain/repair.js";

export interface IncidentDiagnosisRunnerPort {
  diagnoseIncident(
    incidentId: string,
    params: { now: string; releaseSha: string; adapterVersion: string },
    actor?: Actor
  ): Promise<{ verdict: RepairPolicyVerdict }>;
}

export interface AutoDiagnosisCoordinatorOptions {
  releaseSha: string;
  adapterVersion: string;
  maxPerCycle?: number;
}

export interface AutoDiagnosisCycleReport {
  inspected: number;
  eligible: number;
  attempted: number;
  diagnosed: number;
  skippedPolicy: number;
  skippedFresh: number;
  skippedInFlight: number;
  failed: number;
  diagnosedIncidentIds: readonly string[];
  failedIncidentIds: readonly string[];
}

/**
 * These incident kinds have deterministic owners and never enter an AI diagnosis call.
 * In particular PUBLISH_UNCERTAIN belongs exclusively to reconciliation; authentication,
 * identity and policy/copyright decisions belong to a human; a missed slot is scheduling state.
 */
const NEVER_AUTO_DIAGNOSE = new Set<Incident["kind"]>([
  "AUTH_REQUIRED",
  "CHALLENGE",
  "IDENTITY_MISMATCH",
  "MISSED_WINDOW",
  "PUBLISH_UNCERTAIN",
  "POLICY_WARNING",
  "COPYRIGHT_WARNING",
  "ACCOUNT_WARNING"
]);

export function isAutoDiagnosableIncident(incident: Incident): boolean {
  return !NEVER_AUTO_DIAGNOSE.has(incident.kind);
}

function latestDiagnosisAt(store: RepairStorePort, incidentId: string): string | undefined {
  return store.listAiDiagnoses(incidentId)
    .map((diagnosis) => diagnosis.createdAt)
    .sort((a, b) => b.localeCompare(a))[0];
}

/**
 * Runs diagnosis once per unresolved incident occurrence. Persistence is the dedupe boundary:
 * when an incident is refreshed/reopened its lastObservedAt moves forward, making one new
 * diagnosis eligible. Failures are contained per incident and can retry on a later cycle.
 *
 * This coordinator diagnoses only. It cannot create a repair branch, replay a surface, authorize
 * final publish, resume an intent, or promote code/configuration.
 */
export class AutoDiagnosisCoordinator {
  private readonly inFlight = new Set<string>();
  private readonly maxPerCycle: number;

  constructor(
    private readonly incidents: IncidentStorePort,
    private readonly repairStore: RepairStorePort,
    private readonly runner: IncidentDiagnosisRunnerPort,
    private readonly options: AutoDiagnosisCoordinatorOptions
  ) {
    if (!options.releaseSha.trim()) throw new Error("Auto diagnosis requires an exact release SHA");
    if (!options.adapterVersion.trim()) throw new Error("Auto diagnosis requires an adapter version");
    this.maxPerCycle = options.maxPerCycle ?? 2;
    if (!Number.isInteger(this.maxPerCycle) || this.maxPerCycle < 1 || this.maxPerCycle > 20) {
      throw new Error("Auto diagnosis maxPerCycle must be an integer from 1 to 20");
    }
  }

  async run(now: string, actor: Actor = { type: "system", id: "auto-diagnosis" }): Promise<AutoDiagnosisCycleReport> {
    const timestamp = new Date(now).toISOString();
    const unresolved = [...this.incidents.listIncidents(["OPEN", "ACKNOWLEDGED"])]
      .sort((a, b) => b.lastObservedAt.localeCompare(a.lastObservedAt));
    let eligible = 0, attempted = 0, skippedPolicy = 0, skippedFresh = 0, skippedInFlight = 0, failed = 0;
    const diagnosedIncidentIds: string[] = [], failedIncidentIds: string[] = [];

    for (const incident of unresolved) {
      if (!isAutoDiagnosableIncident(incident)) { skippedPolicy += 1; continue; }
      eligible += 1;
      const latest = latestDiagnosisAt(this.repairStore, incident.incidentId);
      if (latest && latest >= incident.lastObservedAt) { skippedFresh += 1; continue; }
      if (this.inFlight.has(incident.incidentId)) { skippedInFlight += 1; continue; }
      if (attempted >= this.maxPerCycle) continue;

      attempted += 1;
      this.inFlight.add(incident.incidentId);
      try {
        await this.runner.diagnoseIncident(incident.incidentId, {
          now: timestamp,
          releaseSha: this.options.releaseSha,
          adapterVersion: this.options.adapterVersion
        }, actor);
        diagnosedIncidentIds.push(incident.incidentId);
      } catch {
        failed += 1;
        failedIncidentIds.push(incident.incidentId);
      } finally {
        this.inFlight.delete(incident.incidentId);
      }
    }

    return {
      inspected: unresolved.length,
      eligible,
      attempted,
      diagnosed: diagnosedIncidentIds.length,
      skippedPolicy,
      skippedFresh,
      skippedInFlight,
      failed,
      diagnosedIncidentIds,
      failedIncidentIds
    };
  }
}
