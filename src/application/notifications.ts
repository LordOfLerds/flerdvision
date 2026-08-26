import type { Actor } from "../domain/control-plane.js";
import type { Instant } from "../domain/model.js";
import type { NotificationOutboxPort, NotificationPort } from "../domain/operations-ports.js";

export interface NotificationDispatchReport {
  attempted: number;
  sent: number;
  failed: number;
}

export interface NotificationDispatcherOptions {
  retryDelaySeconds?: number;
  maxAttempts?: number;
}

export class NotificationDispatcher {
  private readonly adapters = new Map<string, NotificationPort>();
  private readonly retryDelayMs: number;
  private readonly maxAttempts: number;

  constructor(
    private readonly outbox: NotificationOutboxPort,
    adapters: readonly NotificationPort[],
    options: NotificationDispatcherOptions = {}
  ) {
    this.retryDelayMs = (options.retryDelaySeconds ?? 60) * 1000;
    this.maxAttempts = options.maxAttempts ?? 8;
    if (this.retryDelayMs < 0 || this.maxAttempts < 1) throw new Error("Invalid notification dispatcher retry policy");
    for (const adapter of adapters) {
      if (this.adapters.has(adapter.channelKey)) throw new Error(`Duplicate notification channel: ${adapter.channelKey}`);
      this.adapters.set(adapter.channelKey, adapter);
    }
  }

  async dispatchPending(now: Instant, actor: Actor = { type: "system", id: "notification-dispatcher" }): Promise<NotificationDispatchReport> {
    const nowMs = new Date(now).getTime();
    if (!Number.isFinite(nowMs)) throw new Error(`Invalid notification dispatch time: ${now}`);
    const pending = this.outbox.listNotificationDeliveries(["PENDING", "FAILED"]).filter((delivery) => {
      if (delivery.attempts >= this.maxAttempts) return false;
      if (delivery.status !== "FAILED" || !delivery.lastAttemptAt) return true;
      return nowMs - new Date(delivery.lastAttemptAt).getTime() >= this.retryDelayMs;
    });
    let sent = 0;
    let failed = 0;
    for (const delivery of pending) {
      const message = this.outbox.getNotification(delivery.notificationId);
      if (!message) {
        this.outbox.markNotificationFailed(delivery.notificationId, delivery.channelKey, now, "notification_message_missing", actor);
        failed += 1;
        continue;
      }
      const adapter = this.adapters.get(delivery.channelKey);
      if (!adapter) {
        this.outbox.markNotificationFailed(delivery.notificationId, delivery.channelKey, now, `notification_channel_missing:${delivery.channelKey}`, actor);
        failed += 1;
        continue;
      }
      try {
        const receipt = await adapter.send(message);
        this.outbox.markNotificationSent(delivery.notificationId, delivery.channelKey, now, receipt, actor);
        sent += 1;
      } catch (error) {
        const messageText = error instanceof Error ? error.message : String(error);
        this.outbox.markNotificationFailed(delivery.notificationId, delivery.channelKey, now, messageText, actor);
        failed += 1;
      }
    }
    return { attempted: pending.length, sent, failed };
  }
}
