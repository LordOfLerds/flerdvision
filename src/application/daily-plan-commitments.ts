import { createHash } from "node:crypto";
import type { DailyPlan, PlannedDelivery } from "../domain/distribution.js";
import type { PublicationState } from "../domain/states.js";

export interface DailyPlanCommitment {
  delivery: PlannedDelivery;
  intentId: string;
  reservationId: string;
  state: PublicationState;
}

export interface SuppressedReplanDelivery {
  deliveryId: string;
  reason: "SAME_DELIVERY_COMMITTED" | "ROUTE_SLOT_COMMITTED" | "ACCOUNT_TIME_COMMITTED" | "ROUTE_ASSET_ALREADY_COMMITTED";
  committedDeliveryId: string;
}

export interface DailyPlanCommitmentReconciliation {
  plan: DailyPlan;
  preservedDeliveryIds: readonly string[];
  suppressed: readonly SuppressedReplanDelivery[];
}

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function semanticPlanId(plan: Omit<DailyPlan, "planId">): string {
  return `daily-plan:${plan.businessDate}:${sha(JSON.stringify({
    businessDate: plan.businessDate,
    deliveries: plan.deliveries,
    gaps: plan.gaps,
    backlog: plan.backlog,
    ...(plan.configFingerprint ? { configFingerprint: plan.configFingerprint } : {})
  }))}`;
}

export function reconcileDailyPlanWithCommitments(
  candidate: DailyPlan,
  commitments: readonly DailyPlanCommitment[]
): DailyPlanCommitmentReconciliation {
  const relevant = commitments.filter((item) => item.delivery.businessDate === candidate.businessDate);
  if (relevant.length === 0) return { plan: candidate, preservedDeliveryIds: [], suppressed: [] };

  const preserved = relevant.map((item) => item.delivery);
  const suppressed: SuppressedReplanDelivery[] = [];
  const acceptedCandidates: PlannedDelivery[] = [];

  for (const delivery of candidate.deliveries) {
    let match = relevant.find((item) => item.delivery.deliveryId === delivery.deliveryId);
    if (match) {
      suppressed.push({ deliveryId: delivery.deliveryId, reason: "SAME_DELIVERY_COMMITTED", committedDeliveryId: match.delivery.deliveryId });
      continue;
    }
    match = relevant.find((item) => item.delivery.routeId === delivery.routeId && item.delivery.slotKey === delivery.slotKey);
    if (match) {
      suppressed.push({ deliveryId: delivery.deliveryId, reason: "ROUTE_SLOT_COMMITTED", committedDeliveryId: match.delivery.deliveryId });
      continue;
    }
    match = relevant.find((item) => item.delivery.accountId === delivery.accountId && item.delivery.scheduledFor === delivery.scheduledFor);
    if (match) {
      suppressed.push({ deliveryId: delivery.deliveryId, reason: "ACCOUNT_TIME_COMMITTED", committedDeliveryId: match.delivery.deliveryId });
      continue;
    }
    match = relevant.find((item) => item.delivery.routeId === delivery.routeId && item.delivery.assetId === delivery.assetId);
    if (match) {
      suppressed.push({ deliveryId: delivery.deliveryId, reason: "ROUTE_ASSET_ALREADY_COMMITTED", committedDeliveryId: match.delivery.deliveryId });
      continue;
    }
    acceptedCandidates.push(delivery);
  }

  const committedRouteSlots = new Set(relevant.map((item) => `${item.delivery.routeId}|${item.delivery.slotKey}`));
  const committedRouteAssets = new Set(relevant.map((item) => `${item.delivery.routeId}|${item.delivery.assetId}`));
  const deliveries = [...preserved, ...acceptedCandidates].sort((a, b) =>
    a.scheduledFor.localeCompare(b.scheduledFor) || a.accountId.localeCompare(b.accountId) || a.routeId.localeCompare(b.routeId) || a.assetId.localeCompare(b.assetId)
  );
  const gaps = candidate.gaps.filter((gap) => !gap.routeId || !gap.slotKey || !committedRouteSlots.has(`${gap.routeId}|${gap.slotKey}`));
  const backlog = candidate.backlog.filter((item) => !committedRouteAssets.has(`${item.routeId}|${item.assetId}`));
  const withoutId: Omit<DailyPlan, "planId"> = {
    businessDate: candidate.businessDate,
    generatedAt: candidate.generatedAt,
    deliveries,
    gaps,
    backlog,
    ...(candidate.configFingerprint ? { configFingerprint: candidate.configFingerprint } : {})
  };
  return {
    plan: { ...withoutId, planId: semanticPlanId(withoutId) },
    preservedDeliveryIds: preserved.map((item) => item.deliveryId).sort(),
    suppressed
  };
}
