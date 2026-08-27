import { createHash } from "node:crypto";
import type { NotificationMessage } from "../domain/operations.js";
import type { AttentionItem, AttentionSeverity } from "./control-center-read-model.js";

export interface AttentionNotificationPolicy {
  notify: Readonly<Record<AttentionSeverity, boolean>>;
  uiBaseUrl?: string;
}

export const DEFAULT_ATTENTION_NOTIFICATION_POLICY: AttentionNotificationPolicy = {
  notify: {
    INFO: false,
    WARNING: true,
    ACTION_REQUIRED: true,
    CRITICAL: true
  }
};

function stableId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

export function shouldNotifyAttention(attention: AttentionItem, policy: AttentionNotificationPolicy = DEFAULT_ATTENTION_NOTIFICATION_POLICY): boolean {
  return policy.notify[attention.severity];
}

export function notificationForAttention(
  attention: AttentionItem,
  createdAt: string,
  policy: AttentionNotificationPolicy = DEFAULT_ATTENTION_NOTIFICATION_POLICY
): NotificationMessage | null {
  if (!shouldNotifyAttention(attention, policy)) return null;
  const severity: NotificationMessage["severity"] = attention.severity === "CRITICAL"
    ? "CRITICAL"
    : attention.severity === "ACTION_REQUIRED"
      ? "ERROR"
      : attention.severity === "WARNING"
        ? "WARNING"
        : "INFO";
  const base = policy.uiBaseUrl?.replace(/\/$/, "");
  const deepLink = base ? `${base}${attention.deepLink}` : attention.deepLink;
  const message: NotificationMessage = {
    notificationId: `notification:${stableId(`attention|${attention.attentionId}`)}`,
    dedupeKey: `attention:${attention.attentionId}`,
    kind: "SYSTEM",
    severity,
    createdAt: new Date(createdAt).toISOString(),
    subject: attention.title,
    body: [
      attention.impact,
      attention.slotKey ? `Slot: ${attention.slotKey}` : undefined,
      attention.accountId ? `Account: ${attention.accountId}` : undefined,
      `Open: ${deepLink}`
    ].filter((line): line is string => Boolean(line)).join("\n"),
    metadata: {
      attentionKind: attention.kind,
      attentionSeverity: attention.severity,
      deepLink,
      ...(attention.routeId ? { routeId: attention.routeId } : {}),
      ...(attention.assetId ? { assetId: attention.assetId } : {})
    }
  };
  if (attention.accountId) Object.assign(message, { accountId: attention.accountId });
  return message;
}
