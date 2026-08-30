import { setTimeout as defaultSleep } from "node:timers/promises";

export interface TelegramCommandLoopOptions {
  botToken: string;
  /** The one allowlisted operator chat. Every other sender is ignored and logged. */
  chatId: string;
  /** Executes one chat message and returns the German reply text. */
  execute: (text: string) => Promise<string>;
  fetchImpl?: typeof fetch;
  clock?: () => string;
  sleep?: (ms: number) => Promise<void>;
  /** Telegram long-poll timeout in seconds (default 25). */
  pollTimeoutSeconds?: number;
  /** Backoff after transport/API errors (default 5000 ms). */
  errorBackoffMs?: number;
  /** Messages older than this are dropped as stale so a restart never replays commands (default 300 s). */
  maxCommandAgeSeconds?: number;
  /** Structured operational log line; MUST stay free of tokens and message contents. */
  log?: (line: string) => void;
}

export interface TelegramPollReport {
  handled: number;
  ignored: number;
  stale: number;
  errors: number;
}

interface TelegramUpdate {
  update_id?: number;
  message?: { message_id?: number; date?: number; text?: string; chat?: { id?: number | string }; from?: { id?: number | string } };
}

/**
 * Long-polling command receiver for the operator's Telegram chat. Hard security posture:
 * only the configured chat id is ever answered (everything else is counted+logged, never
 * replied to), stale backlog is dropped after restarts, the bot token never reaches a log
 * line, and the loop has no publish/approve capability -- it can only call the injected
 * execute() and send its reply text back into the same chat.
 */
export class TelegramCommandLoop {
  private readonly fetchImpl: typeof fetch;
  private readonly clock: () => string;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly pollTimeoutSeconds: number;
  private readonly errorBackoffMs: number;
  private readonly maxCommandAgeMs: number;
  private readonly log: (line: string) => void;
  private offset: number | undefined;

  constructor(private readonly options: TelegramCommandLoopOptions) {
    if (!options.botToken.trim() || !options.chatId.trim()) throw new Error("Telegram command loop requires botToken and chatId");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.sleepImpl = options.sleep ?? (async (ms) => { await defaultSleep(ms); });
    this.pollTimeoutSeconds = options.pollTimeoutSeconds ?? 25;
    this.errorBackoffMs = options.errorBackoffMs ?? 5000;
    this.maxCommandAgeMs = (options.maxCommandAgeSeconds ?? 300) * 1000;
    this.log = options.log ?? (() => {});
  }

  /** One getUpdates round trip. Exposed for tests and for embedding into existing cycles. */
  async pollOnce(): Promise<TelegramPollReport> {
    const report: TelegramPollReport = { handled: 0, ignored: 0, stale: 0, errors: 0 };
    let updates: readonly TelegramUpdate[];
    try {
      updates = await this.getUpdates();
    } catch (error) {
      report.errors += 1;
      this.log(`telegram-loop: getUpdates failed (${error instanceof Error ? error.message : String(error)})`);
      return report;
    }
    for (const update of updates) {
      if (typeof update.update_id === "number") this.offset = update.update_id + 1;
      const message = update.message;
      const chatId = message?.chat?.id;
      if (!message || typeof message.text !== "string" || chatId === undefined) { report.ignored += 1; continue; }
      if (String(chatId) !== this.options.chatId) {
        report.ignored += 1;
        this.log(`telegram-loop: update ${update.update_id} from foreign chat ${String(chatId)} ignored`);
        continue;
      }
      const nowMs = new Date(this.clock()).getTime();
      if (typeof message.date === "number" && nowMs - message.date * 1000 > this.maxCommandAgeMs) {
        report.stale += 1;
        this.log(`telegram-loop: update ${update.update_id} dropped as stale`);
        continue;
      }
      let reply: string;
      try {
        reply = await this.options.execute(message.text);
      } catch (error) {
        reply = `🛑 Befehl fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`;
      }
      try {
        await this.sendReply(reply);
        report.handled += 1;
      } catch (error) {
        report.errors += 1;
        this.log(`telegram-loop: reply for update ${update.update_id} failed (${error instanceof Error ? error.message : String(error)})`);
      }
    }
    return report;
  }

  /** Runs until the signal aborts. Long polling paces the loop; errors back off. */
  async run(signal: { aborted: boolean }): Promise<void> {
    while (!signal.aborted) {
      const report = await this.pollOnce();
      if (signal.aborted) break;
      if (report.errors > 0) await this.sleepImpl(this.errorBackoffMs);
    }
  }

  private async getUpdates(): Promise<readonly TelegramUpdate[]> {
    const response = await this.fetchImpl(this.api("getUpdates"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ timeout: this.pollTimeoutSeconds, allowed_updates: ["message"], ...(this.offset !== undefined ? { offset: this.offset } : {}) })
    });
    const payload = await response.json().catch(() => null) as { ok?: boolean; result?: TelegramUpdate[]; description?: string } | null;
    if (!response.ok || !payload?.ok || !Array.isArray(payload.result)) {
      throw new Error(`HTTP ${response.status}${payload?.description ? ` · ${payload.description}` : ""}`);
    }
    return payload.result;
  }

  private async sendReply(text: string): Promise<void> {
    const response = await this.fetchImpl(this.api("sendMessage"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: this.options.chatId, text: text.slice(0, 4000), disable_web_page_preview: true })
    });
    const payload = await response.json().catch(() => null) as { ok?: boolean; description?: string } | null;
    if (!response.ok || !payload?.ok) throw new Error(`HTTP ${response.status}${payload?.description ? ` · ${payload.description}` : ""}`);
  }

  private api(method: string): string {
    return `https://api.telegram.org/bot${this.options.botToken}/${method}`;
  }
}
