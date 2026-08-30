export interface TelegramChatMessengerOptions {
  botToken: string;
  chatId: string;
  fetchImpl?: typeof fetch;
}

interface TelegramApiPayload { ok?: boolean; result?: { message_id?: number } | boolean; description?: string; }

/**
 * Minimal Telegram sender for the operator layer: sendMessage returns the message_id so the
 * daily checklist can later be edited in place via editMessageText. Only these two methods
 * exist -- the messenger cannot fetch updates, join chats or talk to anyone but the one
 * configured operator chat. The bot token never appears in errors or logs.
 */
export class TelegramChatMessenger {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: TelegramChatMessengerOptions) {
    if (!options.botToken.trim() || !options.chatId.trim()) throw new Error("Telegram messenger requires botToken and chatId");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async sendMessage(text: string): Promise<string> {
    const payload = await this.call("sendMessage", { chat_id: this.options.chatId, text: text.slice(0, 4000), disable_web_page_preview: true });
    const result = payload.result;
    const messageId = typeof result === "object" && result !== null ? result.message_id : undefined;
    if (messageId === undefined) throw new Error("Telegram sendMessage returned no message_id");
    return String(messageId);
  }

  async editMessageText(messageId: string, text: string): Promise<void> {
    await this.call("editMessageText", { chat_id: this.options.chatId, message_id: Number(messageId), text: text.slice(0, 4000), disable_web_page_preview: true }, /message is not modified/i);
  }

  private async call(method: string, body: Record<string, unknown>, tolerate?: RegExp): Promise<TelegramApiPayload> {
    const response = await this.fetchImpl(`https://api.telegram.org/bot${this.options.botToken}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    const payload = await response.json().catch(() => null) as TelegramApiPayload | null;
    if (!response.ok || !payload?.ok) {
      if (tolerate && payload?.description && tolerate.test(payload.description)) return payload ?? {};
      throw new Error(`Telegram ${method} failed: HTTP ${response.status}${payload?.description ? ` · ${payload.description}` : ""}`);
    }
    return payload;
  }
}
