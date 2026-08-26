import { DatabaseSync } from "node:sqlite";
import type { PublicationIntent, Instant } from "../../domain/model.js";
import type { PublicationState } from "../../domain/states.js";
import { transition as assertTransition } from "../../domain/states.js";
import type {
  Actor,
  AuditEvent,
  ControlPlaneSummary,
  CreateIntentResult,
  ScheduleReservation,
  StoredPublicationIntent,
  WorkerLease
} from "../../domain/control-plane.js";
import type { ControlPlaneStorePort } from "../../domain/control-plane-ports.js";

const ALL_STATES: readonly PublicationState[] = [
  "PLANNED",
  "READY",
  "SCHEDULED",
  "PREPARING",
  "PUBLISHING",
  "VERIFYING",
  "PUBLISH_UNCERTAIN",
  "RETRY_WAIT",
  "VERIFIED",
  "BLOCKED",
  "WAIVED"
];

interface IntentRow {
  intent_id: string;
  content_id: string;
  creator_id: string;
  platform: PublicationIntent["platform"];
  account_id: string;
  format: PublicationIntent["format"];
  copy_version_id: string;
  scheduled_for: string;
  idempotency_key: string;
  state: PublicationState;
  created_at: string;
  updated_at: string;
}

interface ReservationRow {
  reservation_id: string;
  intent_id: string;
  account_id: string;
  platform: PublicationIntent["platform"];
  business_date: string;
  slot_key: string;
  target_at: string;
  window_start_at: string;
  window_end_at: string;
  created_at: string;
}

interface LeaseRow {
  resource_key: string;
  owner_id: string;
  acquired_at: string;
  heartbeat_at: string;
  expires_at: string;
}

interface EventRow {
  sequence: number;
  event_id: string;
  aggregate_type: AuditEvent["aggregateType"];
  aggregate_id: string;
  event_type: string;
  occurred_at: string;
  actor_type: Actor["type"];
  actor_id: string;
  from_state: PublicationState | null;
  to_state: PublicationState | null;
  payload_json: string;
}

export class IdempotencyConflictError extends Error {}
export class ScheduleConflictError extends Error {}
export class IntentNotFoundError extends Error {}

function asIso(instant: Instant): Instant {
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid instant: ${instant}`);
  return date.toISOString();
}

function addSeconds(instant: Instant, seconds: number): Instant {
  return new Date(new Date(instant).getTime() + seconds * 1000).toISOString();
}

function newEventId(prefix: string): string {
  return `${prefix}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 12)}`;
}

function intentFromRow(row: IntentRow): StoredPublicationIntent {
  return {
    intent: {
      intentId: row.intent_id,
      contentId: row.content_id,
      creatorId: row.creator_id,
      platform: row.platform,
      accountId: row.account_id,
      format: row.format,
      copyVersionId: row.copy_version_id,
      scheduledFor: row.scheduled_for,
      idempotencyKey: row.idempotency_key
    },
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function reservationFromRow(row: ReservationRow): ScheduleReservation {
  return {
    reservationId: row.reservation_id,
    intentId: row.intent_id,
    accountId: row.account_id,
    platform: row.platform,
    businessDate: row.business_date,
    slotKey: row.slot_key,
    targetAt: row.target_at,
    windowStartAt: row.window_start_at,
    windowEndAt: row.window_end_at,
    createdAt: row.created_at
  };
}

function leaseFromRow(row: LeaseRow): WorkerLease {
  return {
    resourceKey: row.resource_key,
    ownerId: row.owner_id,
    acquiredAt: row.acquired_at,
    heartbeatAt: row.heartbeat_at,
    expiresAt: row.expires_at
  };
}

function eventFromRow(row: EventRow): AuditEvent {
  const event: AuditEvent = {
    sequence: row.sequence,
    eventId: row.event_id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    occurredAt: row.occurred_at,
    actor: { type: row.actor_type, id: row.actor_id },
    payload: JSON.parse(row.payload_json) as Record<string, unknown>
  };
  if (row.from_state !== null) Object.assign(event, { fromState: row.from_state });
  if (row.to_state !== null) Object.assign(event, { toState: row.to_state });
  return event;
}

function sameIntentPayload(existing: PublicationIntent, candidate: PublicationIntent): boolean {
  return (
    existing.contentId === candidate.contentId &&
    existing.creatorId === candidate.creatorId &&
    existing.platform === candidate.platform &&
    existing.accountId === candidate.accountId &&
    existing.format === candidate.format &&
    existing.copyVersionId === candidate.copyVersionId &&
    asIso(existing.scheduledFor) === asIso(candidate.scheduledFor)
  );
}

export class SqliteControlPlaneStore implements ControlPlaneStorePort {
  private readonly db: DatabaseSync;

  constructor(databasePath: string) {
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = FULL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);

    const migrationOne = this.db.prepare("SELECT version FROM schema_migrations WHERE version = 1").get();
    if (migrationOne) return;

    this.transaction(() => {
      this.db.exec(`
        CREATE TABLE publication_intents (
          intent_id TEXT PRIMARY KEY,
          content_id TEXT NOT NULL,
          creator_id TEXT NOT NULL,
          platform TEXT NOT NULL,
          account_id TEXT NOT NULL,
          format TEXT NOT NULL,
          copy_version_id TEXT NOT NULL,
          scheduled_for TEXT NOT NULL,
          idempotency_key TEXT NOT NULL UNIQUE,
          state TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX idx_publication_intents_state ON publication_intents(state);
        CREATE INDEX idx_publication_intents_account_schedule ON publication_intents(account_id, scheduled_for);

        CREATE TABLE schedule_reservations (
          reservation_id TEXT PRIMARY KEY,
          intent_id TEXT NOT NULL UNIQUE REFERENCES publication_intents(intent_id) ON DELETE RESTRICT,
          account_id TEXT NOT NULL,
          platform TEXT NOT NULL,
          business_date TEXT NOT NULL,
          slot_key TEXT NOT NULL,
          target_at TEXT NOT NULL,
          window_start_at TEXT NOT NULL,
          window_end_at TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE(account_id, target_at)
        );

        CREATE INDEX idx_schedule_due ON schedule_reservations(window_start_at, window_end_at);
        CREATE INDEX idx_schedule_account_date ON schedule_reservations(account_id, business_date);

        CREATE TABLE worker_leases (
          resource_key TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL,
          acquired_at TEXT NOT NULL,
          heartbeat_at TEXT NOT NULL,
          expires_at TEXT NOT NULL
        );

        CREATE INDEX idx_worker_leases_expiry ON worker_leases(expires_at);

        CREATE TABLE event_log (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id TEXT NOT NULL UNIQUE,
          aggregate_type TEXT NOT NULL,
          aggregate_id TEXT NOT NULL,
          event_type TEXT NOT NULL,
          occurred_at TEXT NOT NULL,
          actor_type TEXT NOT NULL,
          actor_id TEXT NOT NULL,
          from_state TEXT,
          to_state TEXT,
          payload_json TEXT NOT NULL
        );

        CREATE INDEX idx_event_aggregate ON event_log(aggregate_type, aggregate_id, sequence);
        CREATE INDEX idx_event_time ON event_log(occurred_at);

        CREATE TRIGGER event_log_no_update
        BEFORE UPDATE ON event_log
        BEGIN
          SELECT RAISE(ABORT, 'event_log is append-only');
        END;

        CREATE TRIGGER event_log_no_delete
        BEFORE DELETE ON event_log
        BEGIN
          SELECT RAISE(ABORT, 'event_log is append-only');
        END;
      `);
      this.db.prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)")
        .run(1, "initial durable control plane", new Date().toISOString());
    });
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const result = fn();
      this.db.exec("COMMIT;");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  private appendEvent(params: {
    aggregateType: AuditEvent["aggregateType"];
    aggregateId: string;
    eventType: string;
    occurredAt: Instant;
    actor: Actor;
    fromState?: PublicationState;
    toState?: PublicationState;
    payload?: Readonly<Record<string, unknown>>;
  }): void {
    this.db.prepare(`
      INSERT INTO event_log(
        event_id, aggregate_type, aggregate_id, event_type, occurred_at,
        actor_type, actor_id, from_state, to_state, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      newEventId("event"),
      params.aggregateType,
      params.aggregateId,
      params.eventType,
      asIso(params.occurredAt),
      params.actor.type,
      params.actor.id,
      params.fromState ?? null,
      params.toState ?? null,
      JSON.stringify(params.payload ?? {})
    );
  }

  createOrGetIntent(intent: PublicationIntent, now: Instant, actor: Actor): CreateIntentResult {
    const normalizedIntent: PublicationIntent = { ...intent, scheduledFor: asIso(intent.scheduledFor) };
    return this.transaction(() => {
      const byKey = this.db.prepare("SELECT * FROM publication_intents WHERE idempotency_key = ?")
        .get(intent.idempotencyKey) as IntentRow | undefined;
      if (byKey) {
        const existing = intentFromRow(byKey);
        if (!sameIntentPayload(existing.intent, normalizedIntent)) {
          throw new IdempotencyConflictError(
            `Idempotency key ${intent.idempotencyKey} already belongs to a different publication payload`
          );
        }
        return { created: false, record: existing };
      }

      const byId = this.db.prepare("SELECT * FROM publication_intents WHERE intent_id = ?")
        .get(intent.intentId) as IntentRow | undefined;
      if (byId) {
        throw new IdempotencyConflictError(`Intent id ${intent.intentId} already exists with another idempotency key`);
      }

      const timestamp = asIso(now);
      this.db.prepare(`
        INSERT INTO publication_intents(
          intent_id, content_id, creator_id, platform, account_id, format,
          copy_version_id, scheduled_for, idempotency_key, state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        normalizedIntent.intentId,
        normalizedIntent.contentId,
        normalizedIntent.creatorId,
        normalizedIntent.platform,
        normalizedIntent.accountId,
        normalizedIntent.format,
        normalizedIntent.copyVersionId,
        normalizedIntent.scheduledFor,
        normalizedIntent.idempotencyKey,
        "PLANNED",
        timestamp,
        timestamp
      );

      this.appendEvent({
        aggregateType: "publication_intent",
        aggregateId: normalizedIntent.intentId,
        eventType: "intent.created",
        occurredAt: timestamp,
        actor,
        toState: "PLANNED",
        payload: { idempotencyKey: normalizedIntent.idempotencyKey }
      });

      return { created: true, record: this.getIntentOrThrow(normalizedIntent.intentId) };
    });
  }

  getIntent(intentId: string): StoredPublicationIntent | null {
    const row = this.db.prepare("SELECT * FROM publication_intents WHERE intent_id = ?").get(intentId) as IntentRow | undefined;
    return row ? intentFromRow(row) : null;
  }

  private getIntentOrThrow(intentId: string): StoredPublicationIntent {
    const record = this.getIntent(intentId);
    if (!record) throw new IntentNotFoundError(`Publication intent not found: ${intentId}`);
    return record;
  }

  listIntents(states?: readonly PublicationState[]): readonly StoredPublicationIntent[] {
    if (!states || states.length === 0) {
      return (this.db.prepare("SELECT * FROM publication_intents ORDER BY scheduled_for, intent_id").all() as IntentRow[])
        .map(intentFromRow);
    }
    const placeholders = states.map(() => "?").join(",");
    return (this.db.prepare(`SELECT * FROM publication_intents WHERE state IN (${placeholders}) ORDER BY scheduled_for, intent_id`)
      .all(...states) as IntentRow[]).map(intentFromRow);
  }

  transitionIntent(intentId: string, to: PublicationState, now: Instant, actor: Actor, reason?: string): StoredPublicationIntent {
    return this.transaction(() => this.transitionIntentInsideTransaction(intentId, to, now, actor, reason));
  }

  private transitionIntentInsideTransaction(
    intentId: string,
    to: PublicationState,
    now: Instant,
    actor: Actor,
    reason?: string
  ): StoredPublicationIntent {
    const current = this.getIntentOrThrow(intentId);
    assertTransition(current.state, to);
    const timestamp = asIso(now);
    const result = this.db.prepare("UPDATE publication_intents SET state = ?, updated_at = ? WHERE intent_id = ? AND state = ?")
      .run(to, timestamp, intentId, current.state);
    if (result.changes !== 1) throw new Error(`Concurrent state change detected for ${intentId}`);

    this.appendEvent({
      aggregateType: "publication_intent",
      aggregateId: intentId,
      eventType: "intent.transitioned",
      occurredAt: timestamp,
      actor,
      fromState: current.state,
      toState: to,
      payload: reason ? { reason } : {}
    });
    return this.getIntentOrThrow(intentId);
  }

  reserveIntent(intentId: string, reservation: ScheduleReservation, now: Instant, actor: Actor): ScheduleReservation {
    return this.transaction(() => {
      const intent = this.getIntentOrThrow(intentId);
      if (intent.state !== "READY") {
        throw new ScheduleConflictError(`Intent ${intentId} must be READY before reservation, got ${intent.state}`);
      }
      if (reservation.intentId !== intentId || reservation.accountId !== intent.intent.accountId) {
        throw new ScheduleConflictError(`Reservation does not match intent ${intentId}`);
      }

      const existing = this.getReservationForIntent(intentId);
      if (existing) {
        if (
          existing.targetAt === reservation.targetAt &&
          existing.accountId === reservation.accountId &&
          existing.slotKey === reservation.slotKey
        ) {
          return existing;
        }
        throw new ScheduleConflictError(`Intent ${intentId} already has a different reservation`);
      }

      const collision = this.db.prepare("SELECT * FROM schedule_reservations WHERE account_id = ? AND target_at = ?")
        .get(reservation.accountId, asIso(reservation.targetAt)) as ReservationRow | undefined;
      if (collision) {
        throw new ScheduleConflictError(
          `Account ${reservation.accountId} already has a reservation at ${reservation.targetAt}`
        );
      }

      this.db.prepare(`
        INSERT INTO schedule_reservations(
          reservation_id, intent_id, account_id, platform, business_date, slot_key,
          target_at, window_start_at, window_end_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        reservation.reservationId,
        reservation.intentId,
        reservation.accountId,
        reservation.platform,
        reservation.businessDate,
        reservation.slotKey,
        asIso(reservation.targetAt),
        asIso(reservation.windowStartAt),
        asIso(reservation.windowEndAt),
        asIso(reservation.createdAt)
      );

      this.appendEvent({
        aggregateType: "schedule_reservation",
        aggregateId: reservation.reservationId,
        eventType: "schedule.reserved",
        occurredAt: now,
        actor,
        payload: {
          intentId,
          accountId: reservation.accountId,
          slotKey: reservation.slotKey,
          targetAt: asIso(reservation.targetAt)
        }
      });
      this.transitionIntentInsideTransaction(intentId, "SCHEDULED", now, actor, "schedule_reserved");
      return this.getReservationForIntent(intentId) ?? reservation;
    });
  }

  getReservationForIntent(intentId: string): ScheduleReservation | null {
    const row = this.db.prepare("SELECT * FROM schedule_reservations WHERE intent_id = ?")
      .get(intentId) as ReservationRow | undefined;
    return row ? reservationFromRow(row) : null;
  }

  listReservations(accountId?: string, businessDate?: string): readonly ScheduleReservation[] {
    let sql = "SELECT * FROM schedule_reservations";
    const params: string[] = [];
    const filters: string[] = [];
    if (accountId) {
      filters.push("account_id = ?");
      params.push(accountId);
    }
    if (businessDate) {
      filters.push("business_date = ?");
      params.push(businessDate);
    }
    if (filters.length > 0) sql += ` WHERE ${filters.join(" AND ")}`;
    sql += " ORDER BY target_at, reservation_id";
    return (this.db.prepare(sql).all(...params) as ReservationRow[]).map(reservationFromRow);
  }

  listDueReservations(now: Instant): readonly ScheduleReservation[] {
    const timestamp = asIso(now);
    return (this.db.prepare(`
      SELECT r.*
      FROM schedule_reservations r
      JOIN publication_intents i ON i.intent_id = r.intent_id
      WHERE i.state = 'SCHEDULED'
        AND r.window_start_at <= ?
        AND r.window_end_at >= ?
      ORDER BY r.target_at, r.reservation_id
    `).all(timestamp, timestamp) as ReservationRow[]).map(reservationFromRow);
  }

  listMissedReservations(now: Instant): readonly ScheduleReservation[] {
    const timestamp = asIso(now);
    return (this.db.prepare(`
      SELECT r.*
      FROM schedule_reservations r
      JOIN publication_intents i ON i.intent_id = r.intent_id
      WHERE i.state = 'SCHEDULED'
        AND r.window_end_at < ?
      ORDER BY r.window_end_at, r.reservation_id
    `).all(timestamp) as ReservationRow[]).map(reservationFromRow);
  }

  acquireLease(resourceKey: string, ownerId: string, now: Instant, ttlSeconds: number, actor: Actor): WorkerLease | null {
    if (ttlSeconds <= 0) throw new Error("Lease TTL must be positive");
    return this.transaction(() => {
      const timestamp = asIso(now);
      const existing = this.getLease(resourceKey);
      if (existing && existing.expiresAt > timestamp && existing.ownerId !== ownerId) return null;

      const expiresAt = addSeconds(timestamp, ttlSeconds);
      if (existing) {
        this.db.prepare(`
          UPDATE worker_leases
          SET owner_id = ?, acquired_at = ?, heartbeat_at = ?, expires_at = ?
          WHERE resource_key = ?
        `).run(ownerId, timestamp, timestamp, expiresAt, resourceKey);
      } else {
        this.db.prepare(`
          INSERT INTO worker_leases(resource_key, owner_id, acquired_at, heartbeat_at, expires_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(resourceKey, ownerId, timestamp, timestamp, expiresAt);
      }

      this.appendEvent({
        aggregateType: "worker_lease",
        aggregateId: resourceKey,
        eventType: existing ? "lease.reacquired" : "lease.acquired",
        occurredAt: timestamp,
        actor,
        payload: { ownerId, expiresAt }
      });
      return this.getLease(resourceKey);
    });
  }

  heartbeatLease(resourceKey: string, ownerId: string, now: Instant, ttlSeconds: number, actor: Actor): WorkerLease | null {
    if (ttlSeconds <= 0) throw new Error("Lease TTL must be positive");
    return this.transaction(() => {
      const timestamp = asIso(now);
      const existing = this.getLease(resourceKey);
      if (!existing || existing.ownerId !== ownerId || existing.expiresAt <= timestamp) return null;
      const expiresAt = addSeconds(timestamp, ttlSeconds);
      this.db.prepare("UPDATE worker_leases SET heartbeat_at = ?, expires_at = ? WHERE resource_key = ? AND owner_id = ?")
        .run(timestamp, expiresAt, resourceKey, ownerId);
      this.appendEvent({
        aggregateType: "worker_lease",
        aggregateId: resourceKey,
        eventType: "lease.heartbeat",
        occurredAt: timestamp,
        actor,
        payload: { ownerId, expiresAt }
      });
      return this.getLease(resourceKey);
    });
  }

  releaseLease(resourceKey: string, ownerId: string, now: Instant, actor: Actor): boolean {
    return this.transaction(() => {
      const existing = this.getLease(resourceKey);
      if (!existing || existing.ownerId !== ownerId) return false;
      this.appendEvent({
        aggregateType: "worker_lease",
        aggregateId: resourceKey,
        eventType: "lease.released",
        occurredAt: now,
        actor,
        payload: { ownerId }
      });
      const result = this.db.prepare("DELETE FROM worker_leases WHERE resource_key = ? AND owner_id = ?")
        .run(resourceKey, ownerId);
      return result.changes === 1;
    });
  }

  getLease(resourceKey: string): WorkerLease | null {
    const row = this.db.prepare("SELECT * FROM worker_leases WHERE resource_key = ?")
      .get(resourceKey) as LeaseRow | undefined;
    return row ? leaseFromRow(row) : null;
  }

  listActiveLeases(now: Instant): readonly WorkerLease[] {
    return (this.db.prepare("SELECT * FROM worker_leases WHERE expires_at > ? ORDER BY resource_key")
      .all(asIso(now)) as LeaseRow[]).map(leaseFromRow);
  }

  reapExpiredLeases(now: Instant, actor: Actor): number {
    return this.transaction(() => {
      const timestamp = asIso(now);
      const expired = (this.db.prepare("SELECT * FROM worker_leases WHERE expires_at <= ? ORDER BY resource_key")
        .all(timestamp) as LeaseRow[]).map(leaseFromRow);
      for (const lease of expired) {
        this.appendEvent({
          aggregateType: "worker_lease",
          aggregateId: lease.resourceKey,
          eventType: "lease.expired",
          occurredAt: timestamp,
          actor,
          payload: { previousOwnerId: lease.ownerId, expiredAt: lease.expiresAt }
        });
      }
      this.db.prepare("DELETE FROM worker_leases WHERE expires_at <= ?").run(timestamp);
      return expired.length;
    });
  }

  listEvents(aggregateType?: AuditEvent["aggregateType"], aggregateId?: string): readonly AuditEvent[] {
    let sql = "SELECT * FROM event_log";
    const params: string[] = [];
    const filters: string[] = [];
    if (aggregateType) {
      filters.push("aggregate_type = ?");
      params.push(aggregateType);
    }
    if (aggregateId) {
      filters.push("aggregate_id = ?");
      params.push(aggregateId);
    }
    if (filters.length > 0) sql += ` WHERE ${filters.join(" AND ")}`;
    sql += " ORDER BY sequence";
    return (this.db.prepare(sql).all(...params) as EventRow[]).map(eventFromRow);
  }

  summary(now: Instant): ControlPlaneSummary {
    const states = Object.fromEntries(ALL_STATES.map((state) => [state, 0])) as Record<PublicationState, number>;
    const rows = this.db.prepare("SELECT state, COUNT(*) AS count FROM publication_intents GROUP BY state").all() as Array<{
      state: PublicationState;
      count: number;
    }>;
    for (const row of rows) states[row.state] = Number(row.count);
    const scheduledOpen = Number((this.db.prepare("SELECT COUNT(*) AS count FROM publication_intents WHERE state = 'SCHEDULED'").get() as { count: number }).count);
    return {
      generatedAt: asIso(now),
      states,
      activeLeases: this.listActiveLeases(now).length,
      scheduledOpen,
      dueNow: this.listDueReservations(now).length,
      missedWindows: this.listMissedReservations(now).length
    };
  }
}
