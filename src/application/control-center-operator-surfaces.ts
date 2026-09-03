import type { Incident } from "../domain/operations.js";

export type IncidentAction = "ACKNOWLEDGE" | "RESOLVE_AFTER_FIX" | "RESUME_INTENT" | "OPEN_BROWSER" | "OPEN_RECONCILIATION" | "WAIVE_SLOT" | "OPEN_CONTENT" | "OPEN_ROUTE";

export interface IncidentView {
  incidentId: string;
  severity: string;
  kind: string;
  title: string;
  summary: string;
  impact: string;
  allowedActions: readonly IncidentAction[];
  prohibitedAction?: string;
  deepLink: string;
}

export interface ActivityRecord {
  activityId: string;
  occurredAt: string;
  kind: string;
  title: string;
  summary: string;
  routeId?: string;
  accountId?: string;
  assetId?: string;
  incidentId?: string;
  intentId?: string;
  deepLink?: string;
}

export function incidentView(incident: Incident): IncidentView {
  const base: IncidentView = {
    incidentId: incident.incidentId,
    severity: incident.severity,
    kind: incident.kind,
    title: incident.title,
    summary: incident.summary,
    impact: incident.scope.intentId ? `Publication intent ${incident.scope.intentId} ist betroffen.` : incident.scope.accountId ? `Account ${incident.scope.accountId} ist betroffen.` : "Operativer Workflow ist betroffen.",
    allowedActions: ["ACKNOWLEDGE", "RESOLVE_AFTER_FIX"],
    deepLink: `/incidents/${encodeURIComponent(incident.incidentId)}`
  };
  if (incident.kind === "PUBLISH_UNCERTAIN") return { ...base, allowedActions: ["ACKNOWLEDGE", "OPEN_RECONCILIATION"], prohibitedAction: "Nie Resume/Retry direkt: ausschließlich Reconciliation darf VERIFIED oder SAFE_TO_RETRY entscheiden." };
  if (incident.kind === "AUTH_REQUIRED" || incident.kind === "CHALLENGE" || incident.kind === "IDENTITY_MISMATCH") {
    const view: IncidentView = { ...base, allowedActions: ["ACKNOWLEDGE", "OPEN_BROWSER", "RESUME_INTENT", "RESOLVE_AFTER_FIX"] };
    return incident.kind === "IDENTITY_MISMATCH"
      ? { ...view, prohibitedAction: "Resume ist nur nach erneut HEALTHY + erwarteter Identität + gültigem ursprünglichem Posting-Fenster möglich." }
      : view;
  }
  if (incident.kind === "BROWSER_UNREACHABLE") return { ...base, allowedActions:["ACKNOWLEDGE","OPEN_BROWSER","RESOLVE_AFTER_FIX"] };
  if (incident.kind === "MISSED_WINDOW") return { ...base, allowedActions: ["ACKNOWLEDGE", "WAIVE_SLOT"], prohibitedAction: "Nachholen nur für nie versuchte Posts bis 4 h nach dem Slot; danach wird der Slot übersprungen." };
  if (incident.kind === "SOURCE_BLOCKED") return { ...base, allowedActions: ["ACKNOWLEDGE", "OPEN_CONTENT", "RESOLVE_AFTER_FIX"] };
  if (incident.kind === "PLATFORM_CAPABILITY_MISSING" || incident.kind === "UI_UNKNOWN") return { ...base, allowedActions: ["ACKNOWLEDGE", "OPEN_ROUTE", "RESOLVE_AFTER_FIX"] };
  return base;
}

export function sortActivity(records: readonly ActivityRecord[]): readonly ActivityRecord[] {
  return [...records].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.activityId.localeCompare(a.activityId));
}
