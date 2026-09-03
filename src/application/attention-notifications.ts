import { createHash } from "node:crypto";
import type { NotificationMessage } from "../domain/operations.js";
import type { AttentionItem, AttentionSeverity } from "./control-center-read-model.js";
import {
  germanAttention,
  germanPlatformLabel,
  isContentKind,
  isSessionKind,
  renderOperatorMessage
} from "./operator-message.js";
import type { OperatorChannelRef } from "./operator-plan-view.js";

export interface AttentionNotificationPolicy {
  notify: Readonly<Record<AttentionSeverity, boolean>>;
  /** noVNC/remote-screen URL for a manual re-login (env FLERDVISION_REMOTE_SCREEN_URL). */
  remoteScreenUrl?: string;
  /** The operator's channels, so a message names the channel instead of the account id. */
  channels?: readonly OperatorChannelRef[];
}

export const DEFAULT_ATTENTION_NOTIFICATION_POLICY: AttentionNotificationPolicy = {
  notify: {
    INFO: false,
    WARNING: true,
    ACTION_REQUIRED: true,
    CRITICAL: true
  }
};

const SEVERITY_BADGE: Readonly<Record<AttentionSeverity, string>> = {
  INFO: "ℹ️", WARNING: "⚠️", ACTION_REQUIRED: "🛑", CRITICAL: "🚨"
};

function stableId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

export function shouldNotifyAttention(attention: AttentionItem, policy: AttentionNotificationPolicy = DEFAULT_ATTENTION_NOTIFICATION_POLICY): boolean {
  return policy.notify[attention.severity];
}

/**
 * Turns one attention item into the operator's language: what it means, which channel it is
 * about and what to do about it. The old `/control-center/...` deep link is gone with the UI it
 * pointed at -- a dead link is worse than no link, so a session problem now offers the remote
 * screen (or the login command) instead.
 */
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
  const channel = attention.accountId ? policy.channels?.find((item) => item.accountId === attention.accountId) : undefined;
  const session = isSessionKind(attention.kind);
  const content = isContentKind(attention.kind);
  // An unknown kind falls back to the item's own title: a real sentence beats an invented one.
  const meaning = germanAttention(attention.kind);
  const rendered = renderOperatorMessage("ATTENTION", {
    badge: SEVERITY_BADGE[attention.severity],
    headline: meaning?.meaning ?? attention.title,
    reason: attention.impact,
    ...(meaning ? { nextStep: meaning.action } : {}),
    ...(attention.slotLocalTime ? { slotLocal: attention.slotLocalTime } : {}),
    ...(channel ? { channelName: channel.name, platformLabel: germanPlatformLabel(channel.platform) } : {}),
    // A login command only helps when the fix IS a login; anything else gets its own next step.
    ...(session && channel ? { channelKey: channel.key } : {}),
    ...(session && policy.remoteScreenUrl?.trim() ? { remoteScreenUrl: policy.remoteScreenUrl.trim() } : {}),
    // "Put a video in Drive" is only actionable with the folder it means.
    ...(content && channel?.driveFolderUrl ? { driveFolderUrl: channel.driveFolderUrl } : {})
  });
  const message: NotificationMessage = {
    notificationId: `notification:${stableId(`attention|${attention.attentionId}`)}`,
    dedupeKey: `attention:${attention.attentionId}`,
    kind: "SYSTEM",
    severity,
    createdAt: new Date(createdAt).toISOString(),
    subject: rendered.subject,
    body: rendered.body,
    metadata: {
      attentionKind: attention.kind,
      attentionSeverity: attention.severity,
      ...(attention.routeId ? { routeId: attention.routeId } : {}),
      ...(attention.assetId ? { assetId: attention.assetId } : {})
    }
  };
  if (attention.accountId) Object.assign(message, { accountId: attention.accountId });
  return message;
}
