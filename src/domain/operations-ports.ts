import type { Actor } from "./control-plane.js";
import type { Instant, PublicationIntent } from "./model.js";
import type {
  HumanActionRecord,
  Incident,
  IncidentCandidate,
  KillSwitch,
  KillSwitchScopeType,
  NotificationDelivery,
  NotificationMessage,
  NotificationReceipt,
  OperationalGateDecision
} from "./operations.js";

export interface IncidentStorePort {
  createOrRefreshIncident(candidate: IncidentCandidate, actor: Actor): { created: boolean; reopened: boolean; incident: Incident };
  getIncident(incidentId: string): Incident | null;
  listIncidents(statuses?: readonly Incident["status"][]): readonly Incident[];
  acknowledgeIncident(incidentId: string, at: Instant, operatorId: string, note?: string): Incident;
  resolveIncident(incidentId: string, at: Instant, operatorId: string, note: string): Incident;
}

export interface HumanActionStorePort {
  recordHumanAction(action: HumanActionRecord, actor: Actor): HumanActionRecord;
  listHumanActions(intentId?: string, incidentId?: string): readonly HumanActionRecord[];
}

export interface KillSwitchStorePort {
  setKillSwitch(switchState: KillSwitch, actor: Actor): KillSwitch;
  getKillSwitch(scopeType: KillSwitchScopeType, scopeKey: string): KillSwitch | null;
  listKillSwitches(enabledOnly?: boolean): readonly KillSwitch[];
}

export interface OperationalPublishGatePort {
  evaluate(intent: PublicationIntent): OperationalGateDecision;
  assertAllowed(intent: PublicationIntent): void;
}

export interface NotificationOutboxPort {
  enqueueNotification(message: NotificationMessage, channelKeys: readonly string[], actor: Actor): readonly NotificationDelivery[];
  getNotification(notificationId: string): NotificationMessage | null;
  listNotificationDeliveries(statuses?: readonly NotificationDelivery["status"][]): readonly NotificationDelivery[];
  markNotificationSent(notificationId: string, channelKey: string, at: Instant, receipt: NotificationReceipt, actor: Actor): NotificationDelivery;
  markNotificationFailed(notificationId: string, channelKey: string, at: Instant, error: string, actor: Actor): NotificationDelivery;
}

export interface NotificationPort {
  readonly channelKey: string;
  send(message: NotificationMessage): Promise<NotificationReceipt>;
}

export type OperationsStorePort = IncidentStorePort & HumanActionStorePort & KillSwitchStorePort & NotificationOutboxPort;
