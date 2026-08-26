import type { NotificationMessage, NotificationReceipt } from "../../domain/operations.js";
import type { NotificationPort } from "../../domain/operations-ports.js";

export interface WebhookNotificationAdapterOptions {
  channelKey: string;
  url: string;
  bearerToken?: string;
  fetchImpl?: typeof fetch;
}

export class WebhookNotificationAdapter implements NotificationPort {
  readonly channelKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: WebhookNotificationAdapterOptions) {
    this.channelKey = options.channelKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async send(message: NotificationMessage): Promise<NotificationReceipt> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "idempotency-key": message.dedupeKey
    };
    if (this.options.bearerToken) headers.authorization = `Bearer ${this.options.bearerToken}`;
    const response = await this.fetchImpl(this.options.url, {
      method: "POST",
      headers,
      body: JSON.stringify(message)
    });
    if (!response.ok) throw new Error(`Notification webhook failed: ${response.status} ${response.statusText}`);
    const externalMessageId = response.headers.get("x-message-id") ?? undefined;
    return externalMessageId ? { externalMessageId } : {};
  }
}

export class RecordingNotificationAdapter implements NotificationPort {
  readonly sent: NotificationMessage[] = [];
  constructor(readonly channelKey: string) {}
  async send(message: NotificationMessage): Promise<NotificationReceipt> {
    this.sent.push(message);
    return { externalMessageId: `${this.channelKey}:${this.sent.length}` };
  }
}
