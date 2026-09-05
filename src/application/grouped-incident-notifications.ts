import { createHash } from "node:crypto";
import { germanIncident, isContentKind, renderOperatorMessage, sanitizeOperatorText } from "./operator-message.js";
import {
  DailyOperationsService,
  IncidentReconciliationService,
  OperationsIncidentProjector,
  type OperationsCycleOptions,
  type OperationsCycleReport
} from "./operations.js";
import type { OperatorChannelRef } from "./operator-plan-view.js";
import type { Actor } from "../domain/control-plane.js";
import type { BrowserIdentityStorePort } from "../domain/browser-identity-ports.js";
import type { ControlPlaneStorePort } from "../domain/control-plane-ports.js";
import type { IngressStorePort } from "../domain/ingress-ports.js";
import type { Instant } from "../domain/model.js";
import type { IncidentStorePort, NotificationOutboxPort } from "../domain/operations-ports.js";
import type { Incident, IncidentKind, NotificationMessage } from "../domain/operations.js";
import { DEFAULT_SCHEDULING_POLICY } from "../domain/scheduling.js";

const GROUPABLE_TECHNICAL_KINDS = new Set<IncidentKind>([
  "SYSTEM_ERROR",
  "UI_UNKNOWN",
  "PLATFORM_CAPABILITY_MISSING",
  "BROWSER_UNREACHABLE",
  "UPLOAD_REJECTED",
  "SOURCE_BLOCKED"
]);

const INCIDENT_BADGE: Readonly<Record<Incident["severity"], string>> = { INFO: "ℹ️", WARNING: "⚠️", ERROR: "🛑", CRITICAL: "🚨" };

function stableId(prefix: string, value: string): string {
  return `${prefix}:${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

function diagnosisOrder(a: Incident, b: Incident): number {
  return b.lastObservedAt.localeCompare(a.lastObservedAt) || a.incidentId.localeCompare(b.incidentId);
}

function normalizedCause(incident: Incident): string | undefined {
  const raw = incident.metadata.reason ?? incident.summary;
  const clean = sanitizeOperatorText(raw).replace(/\s+/g, " ").trim().toLocaleLowerCase("de-AT");
  return clean || undefined;
}

function notificationGroupKey(incident: Incident): string {
  if (!GROUPABLE_TECHNICAL_KINDS.has(incident.kind)) return `single:${incident.incidentId}`;
  const cause = normalizedCause(incident);
  if (!cause) return `single:${incident.incidentId}`;
  return ["root", incident.kind, incident.scope.accountId ?? "", incident.scope.platform ?? "", cause].join("|");
}

export interface IncidentAlertGroup {
  groupKey: string;
  primary: Incident;
  incidents: readonly Incident[];
}

/**
 * Operator-only grouping. The durable incidents themselves remain separate. Ordering deliberately
 * matches SqliteControlPlaneStore.listIncidents and AutoDiagnosisCoordinator: newest observation
 * first, incident id as the stable tie-break. The visible primary is therefore the same incident
 * automatic diagnosis reaches first for that root-cause cluster.
 */
export function groupIncidentAlerts(incidents: readonly Incident[]): readonly IncidentAlertGroup[] {
  const ordered = [...incidents].sort(diagnosisOrder);
  const groups = new Map<string, Incident[]>();
  for (const incident of ordered) {
    const key = notificationGroupKey(incident);
    groups.set(key, [...(groups.get(key) ?? []), incident]);
  }
  return [...groups.entries()].map(([groupKey, items]) => ({ groupKey, primary: items[0]!, incidents: items }));
}

export class GroupedIncidentNotificationService {
  constructor(
    private readonly outbox: NotificationOutboxPort,
    private readonly channelKeys: readonly string[],
    private readonly channels: readonly OperatorChannelRef[] = []
  ) {}

  enqueueGroup(group: IncidentAlertGroup, actor: Actor): readonly import("../domain/operations.js").NotificationDelivery[] {
    const incident = group.primary;
    const meaning = germanIncident(incident.kind);
    const channel = incident.scope.accountId ? this.channels.find((item) => item.accountId === incident.scope.accountId) : undefined;
    const rendered = renderOperatorMessage("INCIDENT", {
      badge: INCIDENT_BADGE[incident.severity] ?? "⚠️",
      headline: meaning.meaning,
      reason: meaning.effect,
      nextStep: meaning.nextStep,
      ...(channel ? { channelName: channel.name } : {}),
      ...(isContentKind(incident.kind) && channel?.driveFolderUrl ? { driveFolderUrl: channel.driveFolderUrl } : {})
    });
    const screenshot = group.incidents
      .flatMap((item) => item.evidenceRefs)
      .find((ref) => ref.toLocaleLowerCase("en-US").endsWith(".png"));
    const affected = group.incidents.length;
    const body = affected > 1
      ? [rendered.body, "", `Betroffen: ${affected} Posts mit derselben technischen Ursache.`, "Eine Meldung reicht; intern bleiben alle Fälle einzeln protokolliert."].join("\n")
      : rendered.body;
    const message: NotificationMessage = {
      notificationId: stableId("notification", `incident|${incident.incidentId}|occurrence|${incident.occurrenceCount}`),
      // Keep the primary's canonical key: diagnosis lifecycle updates locate this exact Telegram
      // message by incident + occurrence and edit it instead of opening a second message.
      dedupeKey: `incident:${incident.incidentId}:occurrence:${incident.occurrenceCount}`,
      kind: "INCIDENT",
      severity: incident.severity,
      createdAt: incident.openedAt,
      subject: rendered.subject,
      body,
      metadata: {
        kind: incident.kind,
        status: incident.status,
        ...(affected > 1 ? { affectedCount: String(affected), groupedRootCause: "true" } : {}),
        ...(screenshot ? { screenshotPath: screenshot } : {})
      },
      incidentId: incident.incidentId,
      ...(incident.scope.intentId ? { intentId: incident.scope.intentId } : {}),
      ...(incident.scope.accountId ? { accountId: incident.scope.accountId } : {})
    };
    return this.outbox.enqueueNotification(message, this.channelKeys, actor);
  }
}

type GroupedCycleStore = IncidentStorePort & ControlPlaneStorePort & BrowserIdentityStorePort & IngressStorePort & NotificationOutboxPort;

function localClockParts(now: Instant, timeZone: string): { businessDate: string; minuteOfDay: number } {
  const date = new Date(now);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid instant: ${now}`);
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    businessDate: `${parts.year}-${parts.month}-${parts.day}`,
    minuteOfDay: Number(parts.hour) * 60 + Number(parts.minute)
  };
}

/** Product runtime cycle: durable incidents stay granular; only operator alert delivery is grouped. */
export class GroupedOperationsCycleService {
  private readonly readinessMinuteLocal: number;
  private readonly completionMinuteLocal: number;
  private readonly timeZone: string;

  constructor(private readonly store: GroupedCycleStore, private readonly options: OperationsCycleOptions) {
    this.readinessMinuteLocal = options.readinessMinuteLocal ?? 8 * 60 + 30;
    this.completionMinuteLocal = options.completionMinuteLocal ?? 17 * 60 + 30;
    this.timeZone = options.timeZone ?? DEFAULT_SCHEDULING_POLICY.timeZone;
  }

  run(now: Instant, actor: Actor = { type: "system", id: "operations-cycle" }): OperationsCycleReport {
    const reconciliation = new IncidentReconciliationService(this.store).reconcile(now, actor);
    const projection = new OperationsIncidentProjector(this.store).project(now, actor);
    const alertIncidents = projection.alertIncidentIds
      .map((incidentId) => this.store.getIncident(incidentId))
      .filter((incident): incident is Incident => Boolean(incident));
    const groups = groupIncidentAlerts(alertIncidents);
    const notifications = new GroupedIncidentNotificationService(this.store, this.options.channelKeys, this.options.channels ?? []);
    for (const group of groups) notifications.enqueueGroup(group, actor);

    const local = localClockParts(now, this.timeZone);
    const daily = new DailyOperationsService(this.store);
    let readinessEnqueued = false;
    let completionEnqueued = false;
    if (local.minuteOfDay >= this.readinessMinuteLocal) {
      this.store.enqueueNotification(daily.readinessMessage(local.businessDate, now), this.options.channelKeys, actor);
      readinessEnqueued = true;
    }
    if (local.minuteOfDay >= this.completionMinuteLocal) {
      this.store.enqueueNotification(daily.completionMessage(local.businessDate, now), this.options.channelKeys, actor);
      completionEnqueued = true;
    }
    return {
      projection,
      reconciliation,
      enqueuedIncidentNotifications: groups.length,
      readinessEnqueued,
      completionEnqueued
    };
  }
}
