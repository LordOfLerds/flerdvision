import type { ContentDemandProjection } from "./content-demand.js";
import type { StoredDistributionConfiguration } from "../domain/distribution-ports.js";
import type { DailyPlan } from "../domain/distribution.js";
import { addMinutes, instantForLocalDateTime } from "../domain/scheduling.js";
import { DEFAULT_DISTRIBUTION_RUNTIME_POLICY, type OperatorReadinessPolicy } from "../domain/distribution-operations.js";

export interface PlannedReadinessNotification {
  dedupeKey: string;
  severity: "WARNING" | "ACTION_REQUIRED";
  kind: "MORNING_CONTENT" | "PRE_SLOT_CONTENT" | "PRE_SLOT_ESCALATION";
  dueAt: string;
  title: string;
  body: string;
  deepLink: string;
  laneId?: string;
  routeId?: string;
  slotKey?: string;
}

function due(now: string, at: string): boolean {
  return new Date(now).getTime() >= new Date(at).getTime();
}

export function planReadinessNotifications(input: {
  now: string;
  businessDate: string;
  stored: StoredDistributionConfiguration;
  demand: ContentDemandProjection;
  plan: DailyPlan;
  policy?: OperatorReadinessPolicy;
}): readonly PlannedReadinessNotification[] {
  const policy = input.policy ?? input.stored.runtimePolicy?.readiness ?? DEFAULT_DISTRIBUTION_RUNTIME_POLICY.readiness;
  const out: PlannedReadinessNotification[] = [];
  const morningAt = instantForLocalDateTime(input.businessDate, policy.morningSummaryLocalTime, policy.timeZone);

  if (due(input.now, morningAt)) {
    for (const lane of input.demand.lanes.filter((item) => item.status !== "ENOUGH")) {
      const severity = lane.status === "MISSING" ? "ACTION_REQUIRED" : "WARNING";
      const body = lane.status === "MISSING"
        ? `${lane.readyAssetCount}/${lane.requiredAssetCount} benötigten Videos sind READY; selbst mit ${lane.stabilizingAssetCount} stabilisierenden Dateien fehlt Content.`
        : `${lane.readyAssetCount}/${lane.requiredAssetCount} benötigten Videos sind READY; ${lane.stabilizingAssetCount} weitere Dateien werden noch geprüft.`;
      out.push({
        dedupeKey: `readiness:${input.businessDate}:morning:${lane.laneId}:${lane.status}`,
        severity,
        kind: "MORNING_CONTENT",
        dueAt: morningAt,
        title: lane.status === "MISSING" ? "Content für heute fehlt" : "Content für heute noch nicht vollständig bereit",
        body,
        deepLink: `/sources?lane=${encodeURIComponent(lane.laneId)}`,
        laneId: lane.laneId
      });
    }
  }

  for (const gap of input.plan.gaps.filter((item) => item.kind === "MISSING_CONTENT" && item.routeId && item.slotKey)) {
    const route = input.stored.config.routes.find((item) => item.routeId === gap.routeId);
    if (!route) continue;
    const schedule = input.stored.schedulePolicies[route.schedulePolicyId];
    const slot = schedule?.slots.find((item) => item.key === gap.slotKey);
    if (!schedule || !slot) continue;
    const targetAt = instantForLocalDateTime(input.businessDate, slot.localTime, schedule.timeZone);
    const warningAt = addMinutes(targetAt, -policy.preSlotWarningMinutes);
    const escalationAt = addMinutes(targetAt, -policy.preSlotEscalationMinutes);
    if (due(input.now, warningAt)) {
      out.push({
        dedupeKey: `readiness:${input.businessDate}:pre-slot:${route.routeId}:${slot.key}`,
        severity: "WARNING",
        kind: "PRE_SLOT_CONTENT",
        dueAt: warningAt,
        title: `Content fehlt für ${slot.localTime}`,
        body: gap.reason,
        deepLink: `/routes/${encodeURIComponent(route.routeId)}`,
        routeId: route.routeId,
        slotKey: slot.key
      });
    }
    if (due(input.now, escalationAt)) {
      out.push({
        dedupeKey: `readiness:${input.businessDate}:escalation:${route.routeId}:${slot.key}`,
        severity: "ACTION_REQUIRED",
        kind: "PRE_SLOT_ESCALATION",
        dueAt: escalationAt,
        title: `Posting ${slot.localTime} weiterhin ohne Content`,
        body: `Der Slot ist in ${policy.preSlotEscalationMinutes} Minuten fällig und im aktuellen DailyPlan weiterhin nicht belegt.`,
        deepLink: `/routes/${encodeURIComponent(route.routeId)}`,
        routeId: route.routeId,
        slotKey: slot.key
      });
    }
  }

  return out.sort((a, b) => a.dueAt.localeCompare(b.dueAt) || a.dedupeKey.localeCompare(b.dedupeKey));
}
