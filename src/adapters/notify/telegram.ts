import { existsSync, readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
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

/** Telegram's own limits: one text message, one media caption, one album. */
const MAX_TEXT = 4000;
const MAX_CAPTION = 1024;
const MAX_MEDIA_GROUP = 10;
/** Telegram refuses bot uploads above 50 MB; a bigger video falls back to text. */
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;

function textValue(value: NotificationMessage["metadata"][string] | undefined): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function listValue(value: NotificationMessage["metadata"][string] | undefined): readonly string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string" && item.trim() !== "");
  const single = textValue(value);
  return single ? [single] : [];
}

function readableFile(path: string | undefined, maxBytes?: number): string | undefined {
  if (!path || !existsSync(path)) return undefined;
  if (maxBytes === undefined) return path;
  try { return statSync(path).size < maxBytes ? path : undefined; }
  catch { return undefined; }
}

/**
 * Sends workspace notifications into one Telegram chat. Plugs into the durable outbox +
 * retry dispatcher like every NotificationPort. What the message carries decides the transport:
 * several evidence screenshots become one album (sendMediaGroup), a small local video becomes
 * sendVideo, a single screenshot becomes sendPhoto and everything else plain text. A media
 * caption is hard-capped at 1024 characters by Telegram, so a longer text follows immediately as
 * its own message instead of being silently truncated. The bot token and chat id come from the
 * operator's private environment and are never logged.
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
    const permalink = textValue(message.metadata.permalink);
    if (permalink && !message.body.includes(permalink)) lines.push("", permalink);
    return lines.join("\n").slice(0, MAX_TEXT);
  }

  async send(message: NotificationMessage): Promise<NotificationReceipt> {
    const text = this.text(message);
    const screenshots = listValue(message.metadata.screenshotPaths).filter((path) => existsSync(path)).slice(0, MAX_MEDIA_GROUP);
    if (screenshots.length > 1) return await this.sendMediaGroup(screenshots, text);

    const video = readableFile(textValue(message.metadata.videoPath), MAX_VIDEO_BYTES);
    if (video) return await this.sendVideo(video, text);

    const screenshot = screenshots[0] ?? readableFile(textValue(message.metadata.screenshotPath));
    if (screenshot) return await this.sendPhoto(screenshot, text);

    return await this.sendMessage(text);
  }

  private async sendMessage(text: string): Promise<NotificationReceipt> {
    const response = await this.fetchImpl(this.api("sendMessage"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: this.options.chatId, text, disable_web_page_preview: false })
    });
    return await this.receipt(response);
  }

  private async sendPhoto(path: string, text: string): Promise<NotificationReceipt> {
    const body = new FormData();
    body.set("chat_id", this.options.chatId);
    body.set("caption", text.slice(0, MAX_CAPTION));
    body.set("photo", new File([readFileSync(path)], "evidence.png", { type: "image/png" }));
    const receipt = await this.receipt(await this.fetchImpl(this.api("sendPhoto"), { method: "POST", body }));
    return await this.overflow(text, receipt);
  }

  private async sendVideo(path: string, text: string): Promise<NotificationReceipt> {
    const body = new FormData();
    body.set("chat_id", this.options.chatId);
    body.set("caption", text.slice(0, MAX_CAPTION));
    const name = `video${extname(path) || ".mp4"}`;
    body.set("video", new File([readFileSync(path)], name, { type: "video/mp4" }));
    const receipt = await this.receipt(await this.fetchImpl(this.api("sendVideo"), { method: "POST", body }));
    return await this.overflow(text, receipt);
  }

  /** One album per wave: the caption rides the first item, exactly as Telegram expects. */
  private async sendMediaGroup(paths: readonly string[], text: string): Promise<NotificationReceipt> {
    const body = new FormData();
    body.set("chat_id", this.options.chatId);
    const media = paths.map((path, index) => ({
      type: "photo",
      media: `attach://photo${index}`,
      ...(index === 0 ? { caption: text.slice(0, MAX_CAPTION) } : {})
    }));
    body.set("media", JSON.stringify(media));
    paths.forEach((path, index) => body.set(`photo${index}`, new File([readFileSync(path)], `evidence${index}.png`, { type: "image/png" })));
    const response = await this.fetchImpl(this.api("sendMediaGroup"), { method: "POST", body });
    const receipt = await this.receipt(response, true);
    return await this.overflow(text, receipt);
  }

  /** A caption Telegram would cut goes out again in full as its own message right after. */
  private async overflow(text: string, receipt: NotificationReceipt): Promise<NotificationReceipt> {
    if (text.length <= MAX_CAPTION) return receipt;
    await this.sendMessage(text);
    return receipt;
  }

  private async receipt(response: Response, group = false): Promise<NotificationReceipt> {
    const payload = await response.json().catch(() => null) as { ok?: boolean; result?: { message_id?: number } | { message_id?: number }[]; description?: string } | null;
    if (!response.ok || !payload?.ok) {
      throw new Error(`Telegram send failed: HTTP ${response.status}${payload?.description ? ` · ${payload.description}` : ""}`);
    }
    const result = payload.result;
    const first = group && Array.isArray(result) ? result[0] : (Array.isArray(result) ? result[0] : result);
    const externalMessageId = first?.message_id;
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
