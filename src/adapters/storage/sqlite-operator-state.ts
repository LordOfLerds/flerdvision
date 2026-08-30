import { DatabaseSync } from "node:sqlite";
import type {
  OperatorChecklistMessageRecord,
  OperatorStatePort,
  SchedulePause
} from "../../domain/operator-ports.js";

interface PauseRow { scope_key: string; channel_key: string; reason: string; paused_at: string; paused_by: string; }
interface ChecklistRow { business_date: string; chat_message_id: string; content_hash: string; updated_at: string; }

function iso(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid timestamp: ${value}`);
  return date.toISOString();
}

/**
 * Operator-layer state in the same workspace database as the rest of the control plane:
 * schedule pauses (respected by the due worker), the per-day Telegram checklist message id,
 * and one-shot operator event marks (reports/alarms already sent). Own tables, own class --
 * the safety-critical control-plane store stays untouched.
 */
export class SqliteOperatorStateStore implements OperatorStatePort {
  private readonly db: DatabaseSync;

  constructor(databasePath: string) {
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    this.db.exec(`CREATE TABLE IF NOT EXISTS operator_schedule_pauses(
      scope_key TEXT PRIMARY KEY,
      channel_key TEXT NOT NULL,
      reason TEXT NOT NULL,
      paused_at TEXT NOT NULL,
      paused_by TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS operator_checklist_messages(
      business_date TEXT PRIMARY KEY,
      chat_message_id TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS operator_event_marks(
      event_key TEXT PRIMARY KEY,
      sent_at TEXT NOT NULL
    );`);
  }

  setSchedulePause(pause: SchedulePause): SchedulePause {
    if (!pause.scopeKey.trim()) throw new Error("Schedule pause requires a scope key");
    if (!pause.reason.trim()) throw new Error("Schedule pause requires a reason");
    const normalized: SchedulePause = { ...pause, pausedAt: iso(pause.pausedAt) };
    this.db.prepare(`INSERT INTO operator_schedule_pauses(scope_key,channel_key,reason,paused_at,paused_by) VALUES(?,?,?,?,?)
      ON CONFLICT(scope_key) DO UPDATE SET channel_key=excluded.channel_key,reason=excluded.reason,paused_at=excluded.paused_at,paused_by=excluded.paused_by`)
      .run(normalized.scopeKey, normalized.channelKey, normalized.reason, normalized.pausedAt, normalized.pausedBy);
    return normalized;
  }

  clearSchedulePause(scopeKey: string): boolean {
    const result = this.db.prepare("DELETE FROM operator_schedule_pauses WHERE scope_key=?").run(scopeKey);
    return result.changes > 0;
  }

  getSchedulePause(scopeKey: string): SchedulePause | null {
    const row = this.db.prepare("SELECT scope_key,channel_key,reason,paused_at,paused_by FROM operator_schedule_pauses WHERE scope_key=?").get(scopeKey) as PauseRow | undefined;
    return row ? this.pauseFrom(row) : null;
  }

  listSchedulePauses(): readonly SchedulePause[] {
    const rows = this.db.prepare("SELECT scope_key,channel_key,reason,paused_at,paused_by FROM operator_schedule_pauses ORDER BY scope_key").all() as PauseRow[];
    return rows.map((row) => this.pauseFrom(row));
  }

  getChecklistMessage(businessDate: string): OperatorChecklistMessageRecord | null {
    const row = this.db.prepare("SELECT business_date,chat_message_id,content_hash,updated_at FROM operator_checklist_messages WHERE business_date=?").get(businessDate) as ChecklistRow | undefined;
    if (!row) return null;
    return { businessDate: row.business_date, chatMessageId: row.chat_message_id, contentHash: row.content_hash, updatedAt: row.updated_at };
  }

  putChecklistMessage(record: OperatorChecklistMessageRecord): OperatorChecklistMessageRecord {
    if (!record.businessDate.trim() || !record.chatMessageId.trim()) throw new Error("Checklist message record requires businessDate and chatMessageId");
    const normalized: OperatorChecklistMessageRecord = { ...record, updatedAt: iso(record.updatedAt) };
    this.db.prepare(`INSERT INTO operator_checklist_messages(business_date,chat_message_id,content_hash,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(business_date) DO UPDATE SET chat_message_id=excluded.chat_message_id,content_hash=excluded.content_hash,updated_at=excluded.updated_at`)
      .run(normalized.businessDate, normalized.chatMessageId, normalized.contentHash, normalized.updatedAt);
    return normalized;
  }

  wasOperatorEventSent(eventKey: string): boolean {
    return this.db.prepare("SELECT 1 FROM operator_event_marks WHERE event_key=?").get(eventKey) !== undefined;
  }

  markOperatorEventSent(eventKey: string, at: string): boolean {
    if (!eventKey.trim()) throw new Error("Operator event key cannot be empty");
    const result = this.db.prepare("INSERT OR IGNORE INTO operator_event_marks(event_key,sent_at) VALUES(?,?)").run(eventKey, iso(at));
    return result.changes > 0;
  }

  close(): void { this.db.close(); }

  private pauseFrom(row: PauseRow): SchedulePause {
    return { scopeKey: row.scope_key, channelKey: row.channel_key, reason: row.reason, pausedAt: row.paused_at, pausedBy: row.paused_by };
  }
}
