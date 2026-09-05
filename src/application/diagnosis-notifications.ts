import { createHash } from "node:crypto";
import { sanitizeOperatorText } from "./operator-message.js";
import { RepairPolicy } from "./ai-repair.js";
import type { Actor } from "../domain/control-plane.js";
import type { IncidentStorePort, NotificationOutboxPort } from "../domain/operations-ports.js";
import type { NotificationDelivery, NotificationMessage } from "../domain/operations.js";
import type { RepairStorePort } from "../domain/repair-ports.js";
import type { AiDiagnosis, RepairPolicyVerdict } from "../domain/repair.js";

function stableId(prefix: string, value: string): string {
  return `${prefix}:${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

function concise(value: string, max = 360): string {
  const clean = sanitizeOperatorText(value).replace(/\s+/g, " ").trim();
  if (!clean) return "Technische Ursache erkannt.";
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

function statusLine(verdict: RepairPolicyVerdict): string {
  if (verdict.decision === "AUTO_CANDIDATE") return "Auto-Diagnose: Ursache erkannt. Eine sichere automatische Reparatur ist zulässig, aber noch nicht ausgeführt.";
  if (verdict.decision === "ENGINEERING_REVIEW_REQUIRED") return "Auto-Diagnose: Code- oder Workflow-Reparatur nötig. Das Produktionssystem ändert keinen Code selbst.";
  if (verdict.decision === "HUMAN_ONLY") return "Auto-Diagnose: Für den nächsten Schritt ist eine menschliche Entscheidung nötig.";
  return "Auto-Diagnose: Keine automatische Reparatur zulässig; der geschützte Zustand bleibt bestehen.";
}

type DiagnosisNotificationStore = IncidentStorePort & NotificationOutboxPort & RepairStorePort;

export interface DiagnosisNotificationProjectionReport {
  inspected: number;
  enqueued: number;
  skippedWithoutDiagnosis: number;
  skippedWithoutTelegramMessage: number;
}

/**
 * Turns a persisted diagnosis into an edit of the incident's already-sent Telegram message.
 * The original Telegram message_id is reused from the durable notification delivery; no parallel
 * chat-state table exists. Only sanitized diagnosis text is rendered back to the operator.
 */
export class DiagnosisNotificationProjector {
  private readonly policy = new RepairPolicy();

  constructor(private readonly store: DiagnosisNotificationStore, private readonly channelKey = "telegram") {}

  enqueueDiagnosed(
    incidentIds: readonly string[],
    now: string,
    actor: Actor = { type: "system", id: "diagnosis-notification" }
  ): DiagnosisNotificationProjectionReport {
    let enqueued = 0, skippedWithoutDiagnosis = 0, skippedWithoutTelegramMessage = 0;
    for (const incidentId of [...new Set(incidentIds)]) {
      const incident = this.store.getIncident(incidentId);
      if (!incident) { skippedWithoutDiagnosis += 1; continue; }
      const diagnosis = this.latestDiagnosis(incidentId);
      if (!diagnosis) { skippedWithoutDiagnosis += 1; continue; }
      const original = this.originalTelegramDelivery(incidentId, incident.occurrenceCount);
      if (!original) { skippedWithoutTelegramMessage += 1; continue; }

      const verdict = this.policy.evaluate(incident.kind, diagnosis);
      const message = this.updateMessage(original.message, original.delivery, diagnosis, verdict, now);
      this.store.enqueueNotification(message, [this.channelKey], actor);
      enqueued += 1;
    }
    return { inspected: new Set(incidentIds).size, enqueued, skippedWithoutDiagnosis, skippedWithoutTelegramMessage };
  }

  private latestDiagnosis(incidentId: string): AiDiagnosis | undefined {
    return [...this.store.listAiDiagnoses(incidentId)].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  }

  private originalTelegramDelivery(incidentId: string, occurrenceCount: number): { message: NotificationMessage; delivery: NotificationDelivery } | undefined {
    const dedupeKey = `incident:${incidentId}:occurrence:${occurrenceCount}`;
    for (const delivery of this.store.listNotificationDeliveries(["SENT"])) {
      if (delivery.channelKey !== this.channelKey || !delivery.externalMessageId) continue;
      const message = this.store.getNotification(delivery.notificationId);
      if (!message || message.kind !== "INCIDENT" || message.incidentId !== incidentId || message.dedupeKey !== dedupeKey) continue;
      return { message, delivery };
    }
    return undefined;
  }

  private updateMessage(
    original: NotificationMessage,
    delivery: NotificationDelivery,
    diagnosis: AiDiagnosis,
    verdict: RepairPolicyVerdict,
    now: string
  ): NotificationMessage {
    const rootCause = concise(diagnosis.rootCause);
    const body = [
      original.body.trim(),
      "",
      `Ursache: ${rootCause}`,
      statusLine(verdict)
    ].join("\n");
    const photo = typeof original.metadata.screenshotPath === "string";
    return {
      notificationId: stableId("notification", `diagnosis-update|${diagnosis.diagnosisId}|${delivery.externalMessageId}`),
      dedupeKey: `diagnosis-update:${diagnosis.diagnosisId}:${this.channelKey}`,
      kind: "INCIDENT",
      severity: original.severity,
      createdAt: new Date(now).toISOString(),
      subject: original.subject,
      body,
      ...(original.incidentId ? { incidentId: original.incidentId } : {}),
      ...(original.intentId ? { intentId: original.intentId } : {}),
      ...(original.accountId ? { accountId: original.accountId } : {}),
      metadata: {
        editExternalMessageId: delivery.externalMessageId!,
        editMode: photo ? "caption" : "text",
        lifecycleStage: "diagnosed"
      }
    };
  }
}
