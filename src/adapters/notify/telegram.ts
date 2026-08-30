import { existsSync, readFileSync } from "node:fs";
import type { NotificationMessage, NotificationReceipt } from "../../domain/operations.js";
import type { NotificationPort } from "../../domain/operations-ports.js";

export interface TelegramNotificationAdapterOptions {
  channelKey: string;
  botToken: string;
  chatId: string;
  fetchImpl?: typeof fetch;
}

const SEVERITY_BADGE: Readonly<Record<NotificationMessage["severity"], string>> = {
  INFO: "ℹ️",
  WARNING: "⚠️",
  ERROR: "🛑",
  CRITICAL: "🚨"
};

/**
 * Sends workspace notifications into one Telegram chat. Plugs into the durable outbox +
 * retry dispatcher like every NotificationPort; a message whose metadata names a local
 * screenshot (metadata.screenshotPath) goes out as a photo with caption, everything else as
 * plain text. The bot token and chat id come from the operator's private environment and are
 * never logged.
 */
export class TelegramNotificationAdapter implements NotificationPort {
  readonly channelKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: TelegramNotificationAdapterOptions) {
    if (!options.botToken.trim() || !options.chatId.trim()) throw new Error("Telegram adapter requires botToken and chatId");
    this.channelKey = options.channelKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private api(method: string): string {
    return `https://api.telegram.org/bot${this.options.botToken}/${method}`;
  }

  private text(message: NotificationMessage): string {
    const badge = SEVERITY_BADGE[message.severity] ?? "";
    const lines = [`${badge} ${message.subject}`.trim(), "", message.body.trim()];
    const permalink = message.metadata.permalink;
    if (permalink) lines.push("", permalink);
    return lines.join("\n").slice(0, 4000);
  }

  async send(message: NotificationMessage): Promise<NotificationReceipt> {
    const screenshotPath = message.metadata.screenshotPath;
    if (screenshotPath && existsSync(screenshotPath)) {
      const body = new FormData();
      body.set("chat_id", this.options.chatId);
      body.set("caption", this.text(message).slice(0, 1024));
      const bytes = readFileSync(screenshotPath);
      body.set("photo", new File([bytes], "evidence.png", { type: "image/png" }));
      const response = await this.fetchImpl(this.api("sendPhoto"), { method: "POST", body });
      return await this.receipt(response);
    }
    const response = await this.fetchImpl(this.api("sendMessage"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: this.options.chatId, text: this.text(message), disable_web_page_preview: false })
    });
    return await this.receipt(response);
  }

  private async receipt(response: Response): Promise<NotificationReceipt> {
    const payload = await response.json().catch(() => null) as { ok?: boolean; result?: { message_id?: number }; description?: string } | null;
    if (!response.ok || !payload?.ok) {
      throw new Error(`Telegram send failed: HTTP ${response.status}${payload?.description ? ` · ${payload.description}` : ""}`);
    }
    const externalMessageId = payload.result?.message_id;
    return externalMessageId !== undefined ? { externalMessageId: String(externalMessageId) } : {};
  }
}

/** Reads the operator's private Telegram credentials from the environment, if configured. */
export function telegramAdapterFromEnv(env: Record<string, string | undefined>, channelKey = "telegram"): TelegramNotificationAdapter | undefined {
  const botToken = env.FLERDVISION_TELEGRAM_BOT_TOKEN;
  const chatId = env.FLERDVISION_TELEGRAM_CHAT_ID;
  if (!botToken?.trim() || !chatId?.trim()) return undefined;
  return new TelegramNotificationAdapter({ channelKey, botToken, chatId });
}
