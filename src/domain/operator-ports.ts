import type { Instant } from "./model.js";

/**
 * Operator-facing runtime state for the interactive Telegram layer.
 *
 * A SchedulePause is the operator's reversible "hold this channel" state: it keeps due intents
 * SCHEDULED (the due worker skips paused accounts) without touching kill switches, routes or
 * qualification evidence. scopeKey is an accountId, or "*" for a global pause. It is deliberately
 * weaker than a kill switch: pauses may be lifted from chat, kill switches may not.
 */
export interface SchedulePause {
  /** accountId (e.g. "account:instagram:reels") or "*" for every channel. */
  scopeKey: string;
  /** The operator-visible channel key ("reels", …) or "alle" for the global pause. */
  channelKey: string;
  reason: string;
  pausedAt: Instant;
  pausedBy: string;
}

export interface SchedulePauseStorePort {
  setSchedulePause(pause: SchedulePause): SchedulePause;
  /** Returns true when a pause existed and was removed. */
  clearSchedulePause(scopeKey: string): boolean;
  getSchedulePause(scopeKey: string): SchedulePause | null;
  listSchedulePauses(): readonly SchedulePause[];
}

/** One Telegram checklist message per business date, edited in place as posts verify. */
export interface OperatorChecklistMessageRecord {
  businessDate: string;
  chatMessageId: string;
  /** Hash of the last rendered text so unchanged plans never hit editMessageText. */
  contentHash: string;
  updatedAt: Instant;
}

/**
 * Durable chat-side state: which checklist message belongs to which day, and which one-shot
 * operator events (morning/evening/weekly reports, session alarms) already went out.
 */
export interface OperatorChatStatePort {
  getChecklistMessage(businessDate: string): OperatorChecklistMessageRecord | null;
  putChecklistMessage(record: OperatorChecklistMessageRecord): OperatorChecklistMessageRecord;
  wasOperatorEventSent(eventKey: string): boolean;
  /** Idempotent: returns false when the event was already marked. */
  markOperatorEventSent(eventKey: string, at: Instant): boolean;
}

export type OperatorStatePort = SchedulePauseStorePort & OperatorChatStatePort;
