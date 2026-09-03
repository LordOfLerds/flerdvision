import { createHash } from "node:crypto";
import { germanIncident, renderOperatorMessage } from "./operator-message.js";
import type { Actor } from "../domain/control-plane.js";
import type { BrowserIdentityStorePort } from "../domain/browser-identity-ports.js";
import type { ControlPlaneStorePort } from "../domain/control-plane-ports.js";
import type { IngressStorePort } from "../domain/ingress-ports.js";
import type { Instant, PublicationIntent } from "../domain/model.js";
import type {
  HumanActionStorePort,
  IncidentStorePort,
  KillSwitchStorePort,
  NotificationOutboxPort,
  OperationalPublishGatePort
} from "../domain/operations-ports.js";
import type {
  DailyOperationsSummary,
  HumanActionRecord,
  Incident,
  IncidentCandidate,
  IncidentKind,
  IncidentSeverity,
  KillSwitch,
  KillSwitchScopeType,
  NotificationMessage,
  OperationalGateDecision
} from "../domain/operations.js";
import {
  businessDateForInstant,
  DEFAULT_SCHEDULING_POLICY,
  isWithinCatchUp,
  MISSED_WINDOW_WAIVE_REASON,
  type SchedulingPolicy
} from "../domain/scheduling.js";

function stableId(prefix: string, value: string): string {
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 24);
  return `${prefix}:${digest}`;
}

function incidentFingerprint(kind: IncidentKind, parts: readonly string[]): string {
  return `${kind}:${parts.map((part) => part.trim().toLocaleLowerCase("en-US")).join(":")}`;
}

function incidentCandidate(params: {
  kind: IncidentKind;
  severity: IncidentSeverity;
  title: string;
  summary: string;
  observedAt: Instant;
  intentId?: string;
  accountId?: string;
  browserIdentityId?: string;
  sourceObservationId?: string;
  platform?: PublicationIntent["platform"];
  evidenceRefs?: readonly string[];
  metadata?: Readonly<Record<string, string>>;
}): IncidentCandidate {
  const scopeParts = [params.intentId, params.accountId, params.browserIdentityId, params.sourceObservationId, params.platform]
    .filter((part): part is string => Boolean(part));
  const scope: IncidentCandidate["scope"] = {};
  if (params.intentId) Object.assign(scope, { intentId: params.intentId });
  if (params.accountId) Object.assign(scope, { accountId: params.accountId });
  if (params.browserIdentityId) Object.assign(scope, { browserIdentityId: params.browserIdentityId });
  if (params.sourceObservationId) Object.assign(scope, { sourceObservationId: params.sourceObservationId });
  if (params.platform) Object.assign(scope, { platform: params.platform });
  const candidate: IncidentCandidate = {
    fingerprint: incidentFingerprint(params.kind, scopeParts.length > 0 ? scopeParts : [params.title]),
    kind: params.kind,
    severity: params.severity,
    title: params.title,
    summary: params.summary,
    observedAt: new Date(params.observedAt).toISOString(),
    scope
  };
  if (params.evidenceRefs) Object.assign(candidate, { evidenceRefs: params.evidenceRefs });
  if (params.metadata) Object.assign(candidate, { metadata: params.metadata });
  return candidate;
}

export class OperationalKillSwitchError extends Error {
  constructor(readonly decision: OperationalGateDecision) {
    super(`Operational kill switch blocks publication: ${decision.blockingSwitches.map((item) => `${item.scopeType}:${item.scopeKey}`).join(", ")}`);
  }
}

export class KillSwitchGate implements OperationalPublishGatePort {
  constructor(private readonly store: KillSwitchStorePort) {}

  evaluate(intent: PublicationIntent): OperationalGateDecision {
    const blocking = this.store.listKillSwitches(true).filter((item) =>
      item.scopeType === "GLOBAL" ||
      (item.scopeType === "ACCOUNT" && item.scopeKey === intent.accountId) ||
      (item.scopeType === "PLATFORM" && item.scopeKey === intent.platform)
    );
    return { allowed: blocking.length === 0, blockingSwitches: blocking };
  }

  assertAllowed(intent: PublicationIntent): void {
    const decision = this.evaluate(intent);
    if (!decision.allowed) throw new OperationalKillSwitchError(decision);
  }
}

type ProjectionStore = IncidentStorePort & ControlPlaneStorePort & BrowserIdentityStorePort & IngressStorePort;

export interface OperationsProjectionReport {
  created: number;
  refreshed: number;
  incidentIds: readonly string[];
  createdIncidentIds: readonly string[];
  alertIncidentIds: readonly string[];
}

export class OperationsIncidentProjector {
  constructor(
    private readonly store: ProjectionStore,
    private readonly policy: SchedulingPolicy = DEFAULT_SCHEDULING_POLICY
  ) {}

  project(now: Instant, actor: Actor = { type: "system", id: "operations-projector" }): OperationsProjectionReport {
    const candidates: IncidentCandidate[] = [];
    const timestamp = new Date(now).toISOString();

    for (const record of this.store.listIntents(["PUBLISH_UNCERTAIN"])) {
      candidates.push(incidentCandidate({
        kind: "PUBLISH_UNCERTAIN",
        severity: "CRITICAL",
        title: "Publication outcome uncertain",
        summary: `Intent ${record.intent.intentId} may already be published. Reconciliation is required before any retry.`,
        observedAt: timestamp,
        intentId: record.intent.intentId,
        accountId: record.intent.accountId,
        platform: record.intent.platform
      }));
    }

    for (const record of this.store.listIntents(["BLOCKED"])) {
      const events = this.store.listEvents("publication_intent", record.intent.intentId);
      const blockedEvent = [...events].reverse().find((event) => event.toState === "BLOCKED");
      const reason = typeof blockedEvent?.payload.reason === "string" ? blockedEvent.payload.reason : "blocked_without_reason";
      let kind: IncidentKind = "SYSTEM_ERROR";
      let title = "Publication blocked";
      if (reason.startsWith("schedule_window_missed:")) { kind = "MISSED_WINDOW"; title = "Posting window missed"; }
      else if (reason.includes("capability")) { kind = "PLATFORM_CAPABILITY_MISSING"; title = "Required platform capability missing"; }
      else if (reason.includes("auth")) { kind = "AUTH_REQUIRED"; title = "Authentication required"; }
      else if (reason.includes("identity")) { kind = "IDENTITY_MISMATCH"; title = "Account identity mismatch"; }
      candidates.push(incidentCandidate({
        kind,
        severity: kind === "IDENTITY_MISMATCH" ? "CRITICAL" : "ERROR",
        title,
        summary: `Intent ${record.intent.intentId} is blocked: ${reason}`,
        observedAt: blockedEvent?.occurredAt ?? record.updatedAt,
        intentId: record.intent.intentId,
        accountId: record.intent.accountId,
        platform: record.intent.platform,
        metadata: { reason }
      }));
    }

    // Safety net only: in the normal flow MissedWindowGuard.waiveMissed already moves anything
    // past its catch-up deadline out of SCHEDULED before this projector runs (DUE_EXECUTION
    // precedes OPERATIONS in one runtime cycle). This still catches a reservation stuck in
    // SCHEDULED past catch-up when that guard never ran at all (e.g. the R0 frozen due adapter).
    // Anything still inside its catch-up grace period is left alone -- it is still a live
    // candidate for DueWorkClaimer.claimNext, not yet an incident.
    for (const reservation of this.store.listMissedReservations(timestamp)) {
      const record = this.store.getIntent(reservation.intentId);
      if (!record || record.state !== "SCHEDULED") continue;
      if (isWithinCatchUp(reservation.targetAt, this.policy, timestamp)) continue;
      candidates.push(incidentCandidate({
        kind: "MISSED_WINDOW",
        severity: "ERROR",
        title: "Posting window missed",
        summary: `Intent ${reservation.intentId} missed slot ${reservation.slotKey} and its catch-up window has also elapsed without being claimed.`,
        observedAt: timestamp,
        intentId: reservation.intentId,
        accountId: reservation.accountId,
        platform: reservation.platform,
        metadata: { windowEndAt: reservation.windowEndAt, slotKey: reservation.slotKey }
      }));
    }

    // Primary path: MissedWindowGuard.waiveMissed already transitioned the intent to WAIVED with
    // the fixed catch-up-expired reason. Same fingerprint (kind + intentId) as the safety-net
    // loop above, so the two coalesce into exactly one incident regardless of which one fires.
    // WAIVED is terminal -- unlike BLOCKED/PUBLISH_UNCERTAIN the underlying record never leaves
    // this query, so re-running createOrRefreshIncident on every future cycle would otherwise
    // reopen an incident an operator already resolved forever. There is nothing left for anyone
    // to do once an intent is WAIVED, so a resolved incident here stays resolved.
    const resolvedFingerprints = new Set(this.store.listIncidents(["RESOLVED"]).map((incident) => incident.fingerprint));
    for (const record of this.store.listIntents(["WAIVED"])) {
      const events = this.store.listEvents("publication_intent", record.intent.intentId);
      const waivedEvent = [...events].reverse().find((event) => event.toState === "WAIVED");
      const reason = typeof waivedEvent?.payload.reason === "string" ? waivedEvent.payload.reason : "";
      if (reason !== MISSED_WINDOW_WAIVE_REASON) continue;
      const reservation = this.store.getReservationForIntent(record.intent.intentId);
      const candidate = incidentCandidate({
        kind: "MISSED_WINDOW",
        severity: "ERROR",
        title: "Posting window missed",
        summary: `Intent ${record.intent.intentId} missed its posting window; the catch-up window elapsed with no attempt, so it was waived automatically.`,
        observedAt: waivedEvent?.occurredAt ?? record.updatedAt,
        intentId: record.intent.intentId,
        accountId: record.intent.accountId,
        platform: record.intent.platform,
        ...(reservation ? { metadata: { windowEndAt: reservation.windowEndAt, slotKey: reservation.slotKey } } : {})
      });
      if (resolvedFingerprints.has(candidate.fingerprint)) continue;
      candidates.push(candidate);
    }

    for (const identity of this.store.listBrowserIdentities()) {
      const health = this.store.latestSessionHealth(identity.identity.identityId);
      if (!health || health.state === "HEALTHY") continue;
      let kind: IncidentKind;
      let severity: IncidentSeverity = "ERROR";
      if (health.state === "AUTH_REQUIRED") kind = "AUTH_REQUIRED";
      else if (health.state === "CHALLENGE") { kind = "CHALLENGE"; severity = "CRITICAL"; }
      else if (health.state === "IDENTITY_MISMATCH") { kind = "IDENTITY_MISMATCH"; severity = "CRITICAL"; }
      else if (health.state === "UNREACHABLE") kind = "BROWSER_UNREACHABLE";
      else kind = "UI_UNKNOWN";
      candidates.push(incidentCandidate({
        kind,
        severity,
        title: `Browser session ${health.state.toLowerCase().replaceAll("_", " ")}`,
        summary: `Browser identity ${identity.identity.identityId} is ${health.state}; publishing must remain blocked until the session is healthy.`,
        observedAt: health.checkedAt,
        accountId: identity.identity.accountId,
        browserIdentityId: identity.identity.identityId,
        platform: identity.identity.platform,
        metadata: { expectedHandle: health.expectedHandle, ...(health.currentUrl ? { currentUrl: health.currentUrl } : {}) }
      }));
    }

    for (const source of this.store.listSourceObservations(["BLOCKED"])) {
      candidates.push(incidentCandidate({
        kind: "SOURCE_BLOCKED",
        severity: "ERROR",
        title: "Content source blocked",
        summary: source.reason ?? `Source observation ${source.observation.observationId} is blocked.`,
        observedAt: source.lastObservedAt,
        sourceObservationId: source.observation.observationId,
        metadata: { sourceId: source.observation.sourceId, externalObjectId: source.observation.externalObjectId }
      }));
    }

    let created = 0;
    let refreshed = 0;
    const incidentIds: string[] = [];
    const createdIncidentIds: string[] = [];
    const alertIncidentIds: string[] = [];
    const uniqueCandidates = [...new Map(candidates.map((candidate) => [candidate.fingerprint, candidate])).values()];
    for (const candidate of uniqueCandidates) {
      const result = this.store.createOrRefreshIncident(candidate, actor);
      incidentIds.push(result.incident.incidentId);
      if (result.created) { created += 1; createdIncidentIds.push(result.incident.incidentId); }
      else refreshed += 1;
      if (result.created || result.reopened) alertIncidentIds.push(result.incident.incidentId);
    }
    return { created, refreshed, incidentIds, createdIncidentIds, alertIncidentIds };
  }
}

export class HumanRecoveryError extends Error {}

type HumanRecoveryStore = IncidentStorePort & HumanActionStorePort & ControlPlaneStorePort & BrowserIdentityStorePort;

function humanActionId(kind: HumanActionRecord["kind"], operatorId: string, at: string): string {
  return stableId("human-action", `${kind}|${operatorId}|${at}|${Math.random()}`);
}

export class HumanRecoveryService {
  constructor(private readonly store: HumanRecoveryStore) {}

  acknowledgeIncident(incidentId: string, at: Instant, operatorId: string, note?: string): Incident {
    const normalized = new Date(at).toISOString();
    const incident = this.store.acknowledgeIncident(incidentId, normalized, operatorId, note);
    const action: HumanActionRecord = {
      actionId: humanActionId("INCIDENT_ACKNOWLEDGED", operatorId, normalized),
      kind: "INCIDENT_ACKNOWLEDGED",
      occurredAt: normalized,
      operatorId,
      incidentId,
      payload: {}
    };
    if (note) Object.assign(action, { note });
    this.store.recordHumanAction(action, { type: "operator", id: operatorId });
    return incident;
  }

  resolveIncident(incidentId: string, at: Instant, operatorId: string, note: string): Incident {
    if (!note.trim()) throw new HumanRecoveryError("Resolving an incident requires a note");
    const normalized = new Date(at).toISOString();
    const incident = this.store.resolveIncident(incidentId, normalized, operatorId, note);
    this.store.recordHumanAction({
      actionId: humanActionId("INCIDENT_RESOLVED", operatorId, normalized),
      kind: "INCIDENT_RESOLVED",
      occurredAt: normalized,
      operatorId,
      incidentId,
      note,
      payload: {}
    }, { type: "operator", id: operatorId });
    return incident;
  }

  resumeIntent(intentId: string, at: Instant, operatorId: string, note: string): void {
    const normalized = new Date(at).toISOString();
    const record = this.store.getIntent(intentId);
    if (!record) throw new HumanRecoveryError(`Unknown publication intent: ${intentId}`);
    if (record.state === "PUBLISH_UNCERTAIN") throw new HumanRecoveryError("PUBLISH_UNCERTAIN can only continue through reconciliation, never manual resume");
    if (record.state !== "BLOCKED") throw new HumanRecoveryError(`Only BLOCKED intents can be manually resumed; got ${record.state}`);

    const identity = this.store.listBrowserIdentities().find((item) => item.identity.accountId === record.intent.accountId);
    if (identity) {
      const health = this.store.latestSessionHealth(identity.identity.identityId);
      if (!health || health.state !== "HEALTHY") throw new HumanRecoveryError(`Browser session is not healthy for ${record.intent.accountId}`);
    }

    const reservation = this.store.getReservationForIntent(intentId);
    if (!reservation) throw new HumanRecoveryError("Blocked intent has no reservation; explicit rescheduling is required");
    if (normalized > reservation.windowEndAt) throw new HumanRecoveryError("Original posting window has expired; resume would create an unsafe catch-up post");

    this.store.transitionIntent(intentId, "SCHEDULED", normalized, { type: "operator", id: operatorId }, `human_resume:${note}`);
    this.store.recordHumanAction({
      actionId: humanActionId("INTENT_RESUMED", operatorId, normalized),
      kind: "INTENT_RESUMED",
      occurredAt: normalized,
      operatorId,
      intentId,
      note,
      payload: { targetState: "SCHEDULED" }
    }, { type: "operator", id: operatorId });
  }

  waiveIntent(intentId: string, at: Instant, operatorId: string, reason: string): void {
    if (!reason.trim()) throw new HumanRecoveryError("Waiving an intent requires a reason");
    const normalized = new Date(at).toISOString();
    const record = this.store.getIntent(intentId);
    if (!record) throw new HumanRecoveryError(`Unknown publication intent: ${intentId}`);
    if (record.state === "VERIFIED" || record.state === "WAIVED") throw new HumanRecoveryError(`Intent ${intentId} is already terminal: ${record.state}`);
    this.store.transitionIntent(intentId, "WAIVED", normalized, { type: "operator", id: operatorId }, `human_waive:${reason}`);
    this.store.recordHumanAction({
      actionId: humanActionId("INTENT_WAIVED", operatorId, normalized),
      kind: "INTENT_WAIVED",
      occurredAt: normalized,
      operatorId,
      intentId,
      note: reason,
      payload: { previousState: record.state }
    }, { type: "operator", id: operatorId });
  }
}

export class KillSwitchService {
  constructor(private readonly store: KillSwitchStorePort & HumanActionStorePort) {}

  set(scopeType: KillSwitchScopeType, scopeKey: string, enabled: boolean, reason: string, at: Instant, operatorId: string): KillSwitch {
    if (!reason.trim()) throw new Error("Kill switch change requires a reason");
    const normalizedKey = scopeType === "GLOBAL" ? "*" : scopeType === "PLATFORM" ? scopeKey.trim().toLocaleLowerCase("en-US") : scopeKey.trim();
    if (!normalizedKey) throw new Error("Kill switch scope key cannot be empty");
    const normalizedAt = new Date(at).toISOString();
    const state: KillSwitch = {
      scopeType,
      scopeKey: normalizedKey,
      enabled,
      reason,
      updatedAt: normalizedAt,
      updatedBy: operatorId
    };
    const stored = this.store.setKillSwitch(state, { type: "operator", id: operatorId });
    this.store.recordHumanAction({
      actionId: humanActionId("KILL_SWITCH_SET", operatorId, normalizedAt),
      kind: "KILL_SWITCH_SET",
      occurredAt: normalizedAt,
      operatorId,
      note: reason,
      payload: { scopeType, scopeKey: normalizedKey, enabled: String(enabled) }
    }, { type: "operator", id: operatorId });
    return stored;
  }
}

type DailyStore = ControlPlaneStorePort & IncidentStorePort;

export class DailyOperationsService {
  constructor(private readonly store: DailyStore) {}

  summary(businessDate: string, now: Instant): DailyOperationsSummary {
    const items = this.store.listIntents()
      .filter((record) => businessDateForInstant(record.intent.scheduledFor, DEFAULT_SCHEDULING_POLICY.timeZone) === businessDate)
      .map((record) => {
        const reservation = this.store.getReservationForIntent(record.intent.intentId);
        const item = {
          intentId: record.intent.intentId,
          accountId: record.intent.accountId,
          creatorId: record.intent.creatorId,
          platform: record.intent.platform,
          state: record.state
        } as const;
        return reservation ? { ...item, targetAt: reservation.targetAt, slotKey: reservation.slotKey } : item;
      });
    const count = (state: string) => items.filter((item) => item.state === state).length;
    return {
      businessDate,
      generatedAt: new Date(now).toISOString(),
      total: items.length,
      verified: count("VERIFIED"),
      waived: count("WAIVED"),
      blocked: count("BLOCKED"),
      uncertain: count("PUBLISH_UNCERTAIN"),
      scheduledOrActive: items.filter((item) => ["SCHEDULED", "PREPARING", "PUBLISHING", "VERIFYING", "RETRY_WAIT", "READY", "PLANNED"].includes(item.state)).length,
      openIncidents: this.store.listIncidents(["OPEN", "ACKNOWLEDGED"]).filter((incident) => {
        if (!incident.scope.intentId) return true;
        return items.some((item) => item.intentId === incident.scope.intentId);
      }).length,
      items
    };
  }

  readinessMessage(businessDate: string, now: Instant): NotificationMessage {
    const summary = this.summary(businessDate, now);
    const blockers = summary.items.filter((item) => ["BLOCKED", "PUBLISH_UNCERTAIN"].includes(item.state));
    const subject = `Flerdvision readiness · ${businessDate}`;
    const body = [
      `${summary.total} planned publications`,
      `${summary.scheduledOrActive} scheduled/active`,
      `${summary.blocked} blocked`,
      `${summary.uncertain} uncertain`,
      `${summary.openIncidents} open incidents`,
      ...(blockers.length > 0 ? ["", "Needs attention:", ...blockers.map((item) => `- ${item.creatorId} · ${item.platform} · ${item.intentId} · ${item.state}`)] : [])
    ].join("\n");
    return {
      notificationId: stableId("notification", `readiness|${businessDate}`),
      dedupeKey: `readiness:${businessDate}`,
      kind: "READINESS",
      severity: blockers.length > 0 ? "WARNING" : "INFO",
      createdAt: new Date(now).toISOString(),
      subject,
      body,
      metadata: { businessDate }
    };
  }

  completionMessage(businessDate: string, now: Instant): NotificationMessage {
    const summary = this.summary(businessDate, now);
    const complete = summary.total > 0 && summary.verified + summary.waived === summary.total;
    const subject = `Flerdvision day ${complete ? "complete" : "incomplete"} · ${businessDate}`;
    const body = [
      `${summary.verified}/${summary.total} verified`,
      `${summary.waived} waived`,
      `${summary.blocked} blocked`,
      `${summary.uncertain} uncertain`,
      `${summary.openIncidents} open incidents`
    ].join("\n");
    return {
      notificationId: stableId("notification", `completion|${businessDate}|${complete ? "complete" : "incomplete"}`),
      dedupeKey: `completion:${businessDate}:${complete ? "complete" : "incomplete"}`,
      kind: "COMPLETION",
      severity: complete ? "INFO" : "WARNING",
      createdAt: new Date(now).toISOString(),
      subject,
      body,
      metadata: { businessDate, complete: String(complete) }
    };
  }
}

const INCIDENT_BADGE: Readonly<Record<Incident["severity"], string>> = { INFO: "ℹ️", WARNING: "⚠️", ERROR: "🛑", CRITICAL: "🚨" };

export class IncidentNotificationService {
  constructor(private readonly outbox: NotificationOutboxPort, private readonly channelKeys: readonly string[]) {}

  enqueueNewIncident(incident: Incident, actor: Actor): readonly import("../domain/operations.js").NotificationDelivery[] {
    // The operator gets the meaning, the effect on posting and one next step -- never the
    // incident id, the raw kind or an evidence path. The first screenshot rides along as the
    // photo the transport already knows how to send.
    const meaning = germanIncident(incident.kind);
    const rendered = renderOperatorMessage("INCIDENT", {
      badge: INCIDENT_BADGE[incident.severity] ?? "⚠️",
      headline: meaning.meaning,
      reason: meaning.effect,
      nextStep: meaning.nextStep
    });
    const screenshot = incident.evidenceRefs.find((ref) => ref.toLocaleLowerCase("en-US").endsWith(".png"));
    const message: NotificationMessage = {
      notificationId: stableId("notification", `incident|${incident.incidentId}|occurrence|${incident.occurrenceCount}`),
      dedupeKey: `incident:${incident.incidentId}:occurrence:${incident.occurrenceCount}`,
      kind: "INCIDENT",
      severity: incident.severity,
      createdAt: incident.openedAt,
      subject: rendered.subject,
      body: rendered.body,
      metadata: { kind: incident.kind, status: incident.status, ...(screenshot ? { screenshotPath: screenshot } : {}) }
    };
    if (incident.scope.intentId) Object.assign(message, { intentId: incident.scope.intentId });
    if (incident.scope.accountId) Object.assign(message, { accountId: incident.scope.accountId });
    Object.assign(message, { incidentId: incident.incidentId });
    return this.outbox.enqueueNotification(message, this.channelKeys, actor);
  }
}

function localClockParts(now: Instant, timeZone = DEFAULT_SCHEDULING_POLICY.timeZone): { businessDate: string; minuteOfDay: number } {
  const date = new Date(now);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid instant: ${now}`);
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  const businessDate = `${parts.year}-${parts.month}-${parts.day}`;
  const minuteOfDay = Number(parts.hour) * 60 + Number(parts.minute);
  return { businessDate, minuteOfDay };
}

export interface OperationsCycleOptions {
  channelKeys: readonly string[];
  readinessMinuteLocal?: number;
  completionMinuteLocal?: number;
  timeZone?: string;
}

export interface OperationsCycleReport {
  projection: OperationsProjectionReport;
  enqueuedIncidentNotifications: number;
  readinessEnqueued: boolean;
  completionEnqueued: boolean;
}

export class OperationsCycleService {
  private readonly readinessMinuteLocal: number;
  private readonly completionMinuteLocal: number;
  private readonly timeZone: string;

  constructor(
    private readonly store: ProjectionStore & NotificationOutboxPort,
    private readonly options: OperationsCycleOptions
  ) {
    this.readinessMinuteLocal = options.readinessMinuteLocal ?? 8 * 60 + 30;
    this.completionMinuteLocal = options.completionMinuteLocal ?? 17 * 60 + 30;
    this.timeZone = options.timeZone ?? DEFAULT_SCHEDULING_POLICY.timeZone;
  }

  run(now: Instant, actor: Actor = { type: "system", id: "operations-cycle" }): OperationsCycleReport {
    const projection = new OperationsIncidentProjector(this.store).project(now, actor);
    const notifications = new IncidentNotificationService(this.store, this.options.channelKeys);
    for (const incidentId of projection.alertIncidentIds) {
      const incident = this.store.getIncident(incidentId);
      if (incident) notifications.enqueueNewIncident(incident, actor);
    }
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
      enqueuedIncidentNotifications: projection.alertIncidentIds.length,
      readinessEnqueued,
      completionEnqueued
    };
  }
}
