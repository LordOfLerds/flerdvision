import type { AuditEvent } from "../domain/control-plane.js";
import type { ActivityRecord } from "./control-center-operator-surfaces.js";
import { sortActivity } from "./control-center-operator-surfaces.js";

function deepLink(event: AuditEvent): string {
  if (event.aggregateType === "incident") return `/incidents/${encodeURIComponent(event.aggregateId)}`;
  if (event.aggregateType === "publication_intent" || event.aggregateType === "schedule_reservation" || event.aggregateType === "publish_attempt" || event.aggregateType === "verification_decision" || event.aggregateType === "verified_publication") return `/today?focus=${encodeURIComponent(event.aggregateId)}`;
  if (event.aggregateType === "source_observation" || event.aggregateType === "content_item" || event.aggregateType === "source_disposition") return `/content?focus=${encodeURIComponent(event.aggregateId)}`;
  if (event.aggregateType === "social_account" || event.aggregateType === "browser_identity" || event.aggregateType === "session_health" || event.aggregateType === "platform_capability") return `/channels?focus=${encodeURIComponent(event.aggregateId)}`;
  return `/activity?focus=${encodeURIComponent(event.aggregateId)}`;
}

export function activityFromAuditEvent(event: AuditEvent): ActivityRecord {
  const transition = event.fromState || event.toState ? `${event.fromState ?? "-"} → ${event.toState ?? "-"}` : "";
  const actor = `${event.actor.type}:${event.actor.id}`;
  return {
    activityId: event.eventId,
    occurredAt: event.occurredAt,
    kind: `${event.aggregateType}:${event.eventType}`,
    title: event.eventType.replaceAll("_", " "),
    summary: [event.aggregateId, transition, `actor ${actor}`].filter(Boolean).join(" · "),
    ...(event.aggregateType === "incident" ? { incidentId: event.aggregateId } : {}),
    ...(event.aggregateType === "publication_intent" ? { intentId: event.aggregateId } : {}),
    deepLink: deepLink(event)
  };
}

export function projectActivity(events: readonly AuditEvent[], limit = 200): readonly ActivityRecord[] {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("Activity limit must be a positive integer");
  return sortActivity(events.map(activityFromAuditEvent)).slice(0, limit);
}
