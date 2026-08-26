import { DatabaseSync } from "node:sqlite";
import type { ContentItem, PublicationIntent, SourceObservation, Instant } from "../../domain/model.js";
import type { BrowserIdentity, SessionHealthCheck, SocialAccount, StoredBrowserIdentity, StoredSocialAccount } from "../../domain/browser-identity.js";
import { normalizeSocialHandle } from "../../domain/browser-identity.js";
import type { BrowserIdentityStorePort } from "../../domain/browser-identity-ports.js";
import type { PlatformCapabilityProbe } from "../../domain/platform-ui.js";
import type { PlatformCapabilityStorePort } from "../../domain/platform-ui-ports.js";
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
import type { IngressStorePort } from "../../domain/ingress-ports.js";
import type {
  CreateContentResult,
  ObserveSourceResult,
  SourceDispositionRecord,
  SourceObservationState,
  StoredContentItem,
  StoredSourceObservation
} from "../../domain/ingress.js";

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

interface SourceObservationRow {
  observation_id: string;
  source_id: string;
  external_object_id: string;
  observed_at: string;
  locator: string;
  media_fingerprint: string | null;
  metadata_json: string;
  state: SourceObservationState;
  first_observed_at: string;
  last_observed_at: string;
  seen_count: number;
  content_id: string | null;
  reason: string | null;
}

interface ContentItemRow {
  content_id: string;
  accepted_from_observation_id: string;
  creator_id: string;
  media_fingerprint: string;
  immutable_media_ref: string;
  scheduled_business_date: string | null;
  metadata_json: string;
  created_at: string;
}

interface SourceDispositionRow {
  source_observation_id: string;
  state: SourceDispositionRecord["state"];
  publication_ids_json: string;
  reason: string | null;
  updated_at: string;
}

interface SocialAccountRow {
  account_id: string;
  creator_id: string | null;
  platform: SocialAccount["platform"];
  expected_handle: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

interface BrowserIdentityRow {
  identity_id: string;
  account_id: string;
  platform: BrowserIdentity["platform"];
  profile_key: string;
  expected_handle: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

interface SessionHealthRow {
  sequence: number;
  check_id: string;
  identity_id: string;
  checked_at: string;
  state: SessionHealthCheck["state"];
  expected_handle: string;
  observed_handle: string | null;
  current_url: string | null;
  note: string | null;
}

interface PlatformCapabilityProbeRow {
  sequence: number;
  probe_id: string;
  account_id: string;
  identity_id: string;
  platform: PlatformCapabilityProbe["platform"];
  probed_at: string;
  capabilities_json: string;
  current_url: string | null;
  note: string | null;
}

export class IdempotencyConflictError extends Error {}
export class ScheduleConflictError extends Error {}
export class IntentNotFoundError extends Error {}
export class SourceObservationNotFoundError extends Error {}
export class SourceDecisionConflictError extends Error {}
export class ContentConflictError extends Error {}
export class SocialAccountConflictError extends Error {}
export class BrowserIdentityConflictError extends Error {}

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

function sourceObservationFromRow(row: SourceObservationRow): StoredSourceObservation {
  const observation: SourceObservation = {
    observationId: row.observation_id,
    sourceId: row.source_id,
    externalObjectId: row.external_object_id,
    observedAt: row.observed_at,
    locator: row.locator,
    metadata: JSON.parse(row.metadata_json) as Record<string, string>
  };
  if (row.media_fingerprint !== null) Object.assign(observation, { mediaFingerprint: row.media_fingerprint });

  const record: StoredSourceObservation = {
    observation,
    state: row.state,
    firstObservedAt: row.first_observed_at,
    lastObservedAt: row.last_observed_at,
    seenCount: row.seen_count
  };
  if (row.content_id !== null) Object.assign(record, { contentId: row.content_id });
  if (row.reason !== null) Object.assign(record, { reason: row.reason });
  return record;
}

function contentItemFromRow(row: ContentItemRow): StoredContentItem {
  const item: ContentItem = {
    contentId: row.content_id,
    acceptedFromObservationId: row.accepted_from_observation_id,
    creatorId: row.creator_id,
    mediaFingerprint: row.media_fingerprint,
    immutableMediaRef: row.immutable_media_ref,
    metadata: JSON.parse(row.metadata_json) as Record<string, string>
  };
  if (row.scheduled_business_date !== null) Object.assign(item, { scheduledBusinessDate: row.scheduled_business_date });
  return { item, createdAt: row.created_at };
}

function sourceDispositionFromRow(row: SourceDispositionRow): SourceDispositionRecord {
  const record: SourceDispositionRecord = {
    sourceObservationId: row.source_observation_id,
    state: row.state,
    publicationIds: JSON.parse(row.publication_ids_json) as string[],
    updatedAt: row.updated_at
  };
  if (row.reason !== null) Object.assign(record, { reason: row.reason });
  return record;
}


function socialAccountFromRow(row: SocialAccountRow): StoredSocialAccount {
  const account: SocialAccount = {
    accountId: row.account_id,
    platform: row.platform,
    expectedHandle: row.expected_handle,
    enabled: row.enabled === 1
  };
  if (row.creator_id !== null) Object.assign(account, { creatorId: row.creator_id });
  return { account, createdAt: row.created_at, updatedAt: row.updated_at };
}

function browserIdentityFromRow(row: BrowserIdentityRow): StoredBrowserIdentity {
  return {
    identity: {
      identityId: row.identity_id,
      accountId: row.account_id,
      platform: row.platform,
      profileKey: row.profile_key,
      expectedHandle: row.expected_handle,
      enabled: row.enabled === 1
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function sessionHealthFromRow(row: SessionHealthRow): SessionHealthCheck {
  const check: SessionHealthCheck = {
    checkId: row.check_id,
    identityId: row.identity_id,
    checkedAt: row.checked_at,
    state: row.state,
    expectedHandle: row.expected_handle
  };
  if (row.observed_handle !== null) Object.assign(check, { observedHandle: row.observed_handle });
  if (row.current_url !== null) Object.assign(check, { currentUrl: row.current_url });
  if (row.note !== null) Object.assign(check, { note: row.note });
  return check;
}

function platformCapabilityProbeFromRow(row: PlatformCapabilityProbeRow): PlatformCapabilityProbe {
  const probe: PlatformCapabilityProbe = {
    probeId: row.probe_id,
    accountId: row.account_id,
    identityId: row.identity_id,
    platform: row.platform,
    probedAt: row.probed_at,
    capabilities: JSON.parse(row.capabilities_json) as PlatformCapabilityProbe["capabilities"]
  };
  if (row.current_url !== null) Object.assign(probe, { currentUrl: row.current_url });
  if (row.note !== null) Object.assign(probe, { note: row.note });
  return probe;
}

function sameSocialAccount(existing: SocialAccount, candidate: SocialAccount): boolean {
  return (existing.creatorId ?? null) === (candidate.creatorId ?? null) &&
    existing.platform === candidate.platform &&
    normalizeSocialHandle(existing.expectedHandle) === normalizeSocialHandle(candidate.expectedHandle) &&
    existing.enabled === candidate.enabled;
}

function sameBrowserIdentity(existing: BrowserIdentity, candidate: BrowserIdentity): boolean {
  return existing.accountId === candidate.accountId &&
    existing.platform === candidate.platform &&
    existing.profileKey === candidate.profileKey &&
    normalizeSocialHandle(existing.expectedHandle) === normalizeSocialHandle(candidate.expectedHandle) &&
    existing.enabled === candidate.enabled;
}

function stableMetadata(metadata: Readonly<Record<string, string>>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(metadata).sort(([a], [b]) => a.localeCompare(b))));
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

export class SqliteControlPlaneStore implements ControlPlaneStorePort, IngressStorePort, BrowserIdentityStorePort, PlatformCapabilityStorePort {
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
    if (!migrationOne) {
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

    const migrationTwo = this.db.prepare("SELECT version FROM schema_migrations WHERE version = 2").get();
    if (!migrationTwo) {
      this.transaction(() => {
        this.db.exec(`
          CREATE TABLE source_observations (
            observation_id TEXT PRIMARY KEY,
            source_id TEXT NOT NULL,
            external_object_id TEXT NOT NULL,
            observed_at TEXT NOT NULL,
            locator TEXT NOT NULL,
            media_fingerprint TEXT,
            metadata_json TEXT NOT NULL,
            state TEXT NOT NULL,
            first_observed_at TEXT NOT NULL,
            last_observed_at TEXT NOT NULL,
            seen_count INTEGER NOT NULL,
            content_id TEXT,
            reason TEXT,
            UNIQUE(source_id, external_object_id)
          );

          CREATE INDEX idx_source_observation_state ON source_observations(state);
          CREATE INDEX idx_source_observation_external ON source_observations(source_id, external_object_id);

          CREATE TABLE content_items (
            content_id TEXT PRIMARY KEY,
            accepted_from_observation_id TEXT NOT NULL UNIQUE REFERENCES source_observations(observation_id) ON DELETE RESTRICT,
            creator_id TEXT NOT NULL,
            media_fingerprint TEXT NOT NULL,
            immutable_media_ref TEXT NOT NULL,
            scheduled_business_date TEXT,
            metadata_json TEXT NOT NULL,
            created_at TEXT NOT NULL
          );

          CREATE INDEX idx_content_creator_date ON content_items(creator_id, scheduled_business_date);

          CREATE TABLE source_dispositions (
            source_observation_id TEXT PRIMARY KEY REFERENCES source_observations(observation_id) ON DELETE RESTRICT,
            state TEXT NOT NULL,
            publication_ids_json TEXT NOT NULL,
            reason TEXT,
            updated_at TEXT NOT NULL
          );
        `);
        this.db.prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)")
          .run(2, "pluggable ingress and source disposition", new Date().toISOString());
      });
    }

    const migrationThree = this.db.prepare("SELECT version FROM schema_migrations WHERE version = 3").get();
    if (!migrationThree) {
      this.transaction(() => {
        this.db.exec(`
          CREATE TABLE social_accounts (
            account_id TEXT PRIMARY KEY,
            creator_id TEXT,
            platform TEXT NOT NULL,
            expected_handle TEXT NOT NULL,
            enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );

          CREATE INDEX idx_social_accounts_platform ON social_accounts(platform, enabled);

          CREATE TABLE browser_identities (
            identity_id TEXT PRIMARY KEY,
            account_id TEXT NOT NULL UNIQUE REFERENCES social_accounts(account_id) ON DELETE RESTRICT,
            platform TEXT NOT NULL,
            profile_key TEXT NOT NULL UNIQUE,
            expected_handle TEXT NOT NULL,
            enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );

          CREATE INDEX idx_browser_identity_platform ON browser_identities(platform, enabled);

          CREATE TABLE session_health_checks (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            check_id TEXT NOT NULL UNIQUE,
            identity_id TEXT NOT NULL REFERENCES browser_identities(identity_id) ON DELETE RESTRICT,
            checked_at TEXT NOT NULL,
            state TEXT NOT NULL,
            expected_handle TEXT NOT NULL,
            observed_handle TEXT,
            current_url TEXT,
            note TEXT
          );

          CREATE INDEX idx_session_health_identity_time ON session_health_checks(identity_id, checked_at DESC, sequence DESC);

          CREATE TRIGGER session_health_no_update
          BEFORE UPDATE ON session_health_checks
          BEGIN
            SELECT RAISE(ABORT, 'session_health_checks is append-only');
          END;

          CREATE TRIGGER session_health_no_delete
          BEFORE DELETE ON session_health_checks
          BEGIN
            SELECT RAISE(ABORT, 'session_health_checks is append-only');
          END;
        `);
        this.db.prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)")
          .run(3, "browser identity and session health", new Date().toISOString());
      });
    }

    const migrationFour = this.db.prepare("SELECT version FROM schema_migrations WHERE version = 4").get();
    if (!migrationFour) {
      this.transaction(() => {
        this.db.exec(`
          CREATE TABLE platform_capability_probes (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            probe_id TEXT NOT NULL UNIQUE,
            account_id TEXT NOT NULL REFERENCES social_accounts(account_id) ON DELETE RESTRICT,
            identity_id TEXT NOT NULL REFERENCES browser_identities(identity_id) ON DELETE RESTRICT,
            platform TEXT NOT NULL,
            probed_at TEXT NOT NULL,
            capabilities_json TEXT NOT NULL,
            current_url TEXT,
            note TEXT
          );

          CREATE INDEX idx_platform_capability_account_time
            ON platform_capability_probes(account_id, probed_at DESC, sequence DESC);

          CREATE TRIGGER platform_capability_no_update
          BEFORE UPDATE ON platform_capability_probes
          BEGIN
            SELECT RAISE(ABORT, 'platform_capability_probes is append-only');
          END;

          CREATE TRIGGER platform_capability_no_delete
          BEFORE DELETE ON platform_capability_probes
          BEGIN
            SELECT RAISE(ABORT, 'platform_capability_probes is append-only');
          END;
        `);
        this.db.prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)")
          .run(4, "platform UI capability probes", new Date().toISOString());
      });
    }
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

  observeOrGetSource(observation: SourceObservation, now: Instant, actor: Actor): ObserveSourceResult {
    return this.transaction(() => {
      const timestamp = asIso(now);
      const observedAt = asIso(observation.observedAt);
      const existingRow = this.db.prepare(
        "SELECT * FROM source_observations WHERE source_id = ? AND external_object_id = ?"
      ).get(observation.sourceId, observation.externalObjectId) as SourceObservationRow | undefined;

      if (existingRow) {
        const existing = sourceObservationFromRow(existingRow);
        if (existing.observation.observationId !== observation.observationId) {
          const reason = `Observation identity mismatch for ${observation.sourceId}/${observation.externalObjectId}`;
          this.appendEvent({
            aggregateType: "source_observation",
            aggregateId: existing.observation.observationId,
            eventType: "source.conflict",
            occurredAt: timestamp,
            actor,
            payload: { reason, candidateObservationId: observation.observationId }
          });
          return { status: "conflict", record: existing, reason };
        }
        if (
          existing.observation.mediaFingerprint &&
          observation.mediaFingerprint &&
          existing.observation.mediaFingerprint !== observation.mediaFingerprint
        ) {
          const reason = `Source object changed media fingerprint after first observation`;
          this.appendEvent({
            aggregateType: "source_observation",
            aggregateId: existing.observation.observationId,
            eventType: "source.media_mutation_conflict",
            occurredAt: timestamp,
            actor,
            payload: {
              reason,
              existingFingerprint: existing.observation.mediaFingerprint,
              candidateFingerprint: observation.mediaFingerprint
            }
          });
          return { status: "conflict", record: existing, reason };
        }

        this.db.prepare(
          "UPDATE source_observations SET last_observed_at = ?, seen_count = seen_count + 1 WHERE observation_id = ?"
        ).run(timestamp, existing.observation.observationId);
        this.appendEvent({
          aggregateType: "source_observation",
          aggregateId: existing.observation.observationId,
          eventType: "source.seen_again",
          occurredAt: timestamp,
          actor,
          payload: { seenCount: existing.seenCount + 1 }
        });
        const updated = this.getSourceObservation(existing.observation.observationId);
        if (!updated) throw new Error(`Failed to reload source observation ${existing.observation.observationId}`);
        return { status: "duplicate", record: updated };
      }

      const byObservationId = this.db.prepare("SELECT * FROM source_observations WHERE observation_id = ?")
        .get(observation.observationId) as SourceObservationRow | undefined;
      if (byObservationId) {
        const existing = sourceObservationFromRow(byObservationId);
        const reason = `Observation id ${observation.observationId} already belongs to another source object`;
        this.appendEvent({
          aggregateType: "source_observation",
          aggregateId: observation.observationId,
          eventType: "source.conflict",
          occurredAt: timestamp,
          actor,
          payload: { reason }
        });
        return { status: "conflict", record: existing, reason };
      }

      this.db.prepare(`
        INSERT INTO source_observations(
          observation_id, source_id, external_object_id, observed_at, locator, media_fingerprint, metadata_json,
          state, first_observed_at, last_observed_at, seen_count, content_id, reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        observation.observationId,
        observation.sourceId,
        observation.externalObjectId,
        observedAt,
        observation.locator,
        observation.mediaFingerprint ?? null,
        stableMetadata(observation.metadata),
        "OBSERVED",
        timestamp,
        timestamp,
        1,
        null,
        null
      );
      this.appendEvent({
        aggregateType: "source_observation",
        aggregateId: observation.observationId,
        eventType: "source.observed",
        occurredAt: timestamp,
        actor,
        payload: { sourceId: observation.sourceId, externalObjectId: observation.externalObjectId }
      });
      const created = this.getSourceObservation(observation.observationId);
      if (!created) throw new Error(`Failed to reload source observation ${observation.observationId}`);
      return { status: "created", record: created };
    });
  }

  getSourceObservation(observationId: string): StoredSourceObservation | null {
    const row = this.db.prepare("SELECT * FROM source_observations WHERE observation_id = ?")
      .get(observationId) as SourceObservationRow | undefined;
    return row ? sourceObservationFromRow(row) : null;
  }

  listSourceObservations(states?: readonly SourceObservationState[]): readonly StoredSourceObservation[] {
    if (!states || states.length === 0) {
      return (this.db.prepare(
        "SELECT * FROM source_observations ORDER BY first_observed_at, observation_id"
      ).all() as SourceObservationRow[]).map(sourceObservationFromRow);
    }
    const placeholders = states.map(() => "?").join(",");
    return (this.db.prepare(
      `SELECT * FROM source_observations WHERE state IN (${placeholders}) ORDER BY first_observed_at, observation_id`
    ).all(...states) as SourceObservationRow[]).map(sourceObservationFromRow);
  }

  decideSourceObservation(
    observationId: string,
    decision: Exclude<SourceObservationState, "OBSERVED">,
    now: Instant,
    actor: Actor,
    options?: { contentId?: string; reason?: string }
  ): StoredSourceObservation {
    return this.transaction(() => {
      const current = this.getSourceObservation(observationId);
      if (!current) throw new SourceObservationNotFoundError(`Source observation not found: ${observationId}`);
      if (current.state !== "OBSERVED") {
        const same =
          current.state === decision &&
          (options?.contentId === undefined || current.contentId === options.contentId) &&
          (options?.reason === undefined || current.reason === options.reason);
        if (same) return current;
        throw new SourceDecisionConflictError(
          `Source observation ${observationId} already decided as ${current.state}`
        );
      }
      if (decision === "ACCEPTED" && !options?.contentId) {
        throw new SourceDecisionConflictError(`ACCEPTED source observation ${observationId} requires contentId`);
      }
      const timestamp = asIso(now);
      const result = this.db.prepare(
        "UPDATE source_observations SET state = ?, content_id = ?, reason = ? WHERE observation_id = ? AND state = 'OBSERVED'"
      ).run(decision, options?.contentId ?? null, options?.reason ?? null, observationId);
      if (result.changes !== 1) throw new SourceDecisionConflictError(`Concurrent source decision for ${observationId}`);
      this.appendEvent({
        aggregateType: "source_observation",
        aggregateId: observationId,
        eventType: `source.${decision.toLowerCase()}`,
        occurredAt: timestamp,
        actor,
        payload: { ...(options?.contentId ? { contentId: options.contentId } : {}), ...(options?.reason ? { reason: options.reason } : {}) }
      });
      const updated = this.getSourceObservation(observationId);
      if (!updated) throw new Error(`Failed to reload source observation ${observationId}`);
      return updated;
    });
  }

  createOrGetContent(item: ContentItem, now: Instant, actor: Actor): CreateContentResult {
    return this.transaction(() => {
      const byObservation = this.db.prepare(
        "SELECT * FROM content_items WHERE accepted_from_observation_id = ?"
      ).get(item.acceptedFromObservationId) as ContentItemRow | undefined;
      if (byObservation) {
        const existing = contentItemFromRow(byObservation);
        const same =
          existing.item.contentId === item.contentId &&
          existing.item.creatorId === item.creatorId &&
          existing.item.mediaFingerprint === item.mediaFingerprint &&
          existing.item.immutableMediaRef === item.immutableMediaRef &&
          existing.item.scheduledBusinessDate === item.scheduledBusinessDate &&
          stableMetadata(existing.item.metadata) === stableMetadata(item.metadata);
        if (!same) throw new ContentConflictError(
          `Observation ${item.acceptedFromObservationId} already materialized as different content`
        );
        return { created: false, record: existing };
      }

      const byId = this.db.prepare("SELECT * FROM content_items WHERE content_id = ?")
        .get(item.contentId) as ContentItemRow | undefined;
      if (byId) throw new ContentConflictError(`Content id ${item.contentId} already exists`);

      const timestamp = asIso(now);
      this.db.prepare(`
        INSERT INTO content_items(
          content_id, accepted_from_observation_id, creator_id, media_fingerprint, immutable_media_ref,
          scheduled_business_date, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        item.contentId,
        item.acceptedFromObservationId,
        item.creatorId,
        item.mediaFingerprint,
        item.immutableMediaRef,
        item.scheduledBusinessDate ?? null,
        stableMetadata(item.metadata),
        timestamp
      );
      this.appendEvent({
        aggregateType: "content_item",
        aggregateId: item.contentId,
        eventType: "content.created",
        occurredAt: timestamp,
        actor,
        payload: { observationId: item.acceptedFromObservationId, creatorId: item.creatorId }
      });
      const created = this.getContentItem(item.contentId);
      if (!created) throw new Error(`Failed to reload content item ${item.contentId}`);
      return { created: true, record: created };
    });
  }

  getContentItem(contentId: string): StoredContentItem | null {
    const row = this.db.prepare("SELECT * FROM content_items WHERE content_id = ?")
      .get(contentId) as ContentItemRow | undefined;
    return row ? contentItemFromRow(row) : null;
  }

  listContentItems(): readonly StoredContentItem[] {
    return (this.db.prepare("SELECT * FROM content_items ORDER BY created_at, content_id").all() as ContentItemRow[])
      .map(contentItemFromRow);
  }

  getSourceDisposition(observationId: string): SourceDispositionRecord | null {
    const row = this.db.prepare("SELECT * FROM source_dispositions WHERE source_observation_id = ?")
      .get(observationId) as SourceDispositionRow | undefined;
    return row ? sourceDispositionFromRow(row) : null;
  }

  recordSourceDisposition(record: SourceDispositionRecord, actor: Actor): SourceDispositionRecord {
    return this.transaction(() => {
      const existing = this.getSourceDisposition(record.sourceObservationId);
      const normalizedPublications = [...record.publicationIds].sort();
      if (existing) {
        const same =
          existing.state === record.state &&
          JSON.stringify([...existing.publicationIds].sort()) === JSON.stringify(normalizedPublications) &&
          existing.reason === record.reason;
        if (same) return existing;
        throw new SourceDecisionConflictError(
          `Source disposition ${record.sourceObservationId} already recorded as ${existing.state}`
        );
      }
      const timestamp = asIso(record.updatedAt);
      this.db.prepare(`
        INSERT INTO source_dispositions(source_observation_id, state, publication_ids_json, reason, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        record.sourceObservationId,
        record.state,
        JSON.stringify(normalizedPublications),
        record.reason ?? null,
        timestamp
      );
      this.appendEvent({
        aggregateType: "source_disposition",
        aggregateId: record.sourceObservationId,
        eventType: `source_disposition.${record.state.toLowerCase()}`,
        occurredAt: timestamp,
        actor,
        payload: { publicationIds: normalizedPublications, ...(record.reason ? { reason: record.reason } : {}) }
      });
      const created = this.getSourceDisposition(record.sourceObservationId);
      if (!created) throw new Error(`Failed to reload source disposition ${record.sourceObservationId}`);
      return created;
    });
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

  registerSocialAccount(account: SocialAccount, now: Instant, actor: Actor): { created: boolean; record: StoredSocialAccount } {
    const normalized: SocialAccount = {
      ...account,
      expectedHandle: normalizeSocialHandle(account.expectedHandle)
    };
    return this.transaction(() => {
      const existingRow = this.db.prepare("SELECT * FROM social_accounts WHERE account_id = ?").get(account.accountId) as SocialAccountRow | undefined;
      if (existingRow) {
        const existing = socialAccountFromRow(existingRow);
        if (!sameSocialAccount(existing.account, normalized)) {
          throw new SocialAccountConflictError(`Social account ${account.accountId} already exists with different configuration`);
        }
        return { created: false, record: existing };
      }
      const timestamp = asIso(now);
      this.db.prepare(`
        INSERT INTO social_accounts(account_id, creator_id, platform, expected_handle, enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        normalized.accountId,
        normalized.creatorId ?? null,
        normalized.platform,
        normalized.expectedHandle,
        normalized.enabled ? 1 : 0,
        timestamp,
        timestamp
      );
      this.appendEvent({
        aggregateType: "social_account", aggregateId: normalized.accountId, eventType: "social_account.registered",
        occurredAt: timestamp, actor, payload: { platform: normalized.platform, enabled: normalized.enabled }
      });
      return { created: true, record: this.getSocialAccount(normalized.accountId)! };
    });
  }

  getSocialAccount(accountId: string): StoredSocialAccount | null {
    const row = this.db.prepare("SELECT * FROM social_accounts WHERE account_id = ?").get(accountId) as SocialAccountRow | undefined;
    return row ? socialAccountFromRow(row) : null;
  }

  listSocialAccounts(): readonly StoredSocialAccount[] {
    return (this.db.prepare("SELECT * FROM social_accounts ORDER BY account_id").all() as SocialAccountRow[]).map(socialAccountFromRow);
  }

  registerBrowserIdentity(identity: BrowserIdentity, now: Instant, actor: Actor): { created: boolean; record: StoredBrowserIdentity } {
    const normalized: BrowserIdentity = { ...identity, expectedHandle: normalizeSocialHandle(identity.expectedHandle) };
    return this.transaction(() => {
      const account = this.getSocialAccount(identity.accountId);
      if (!account) throw new BrowserIdentityConflictError(`Social account ${identity.accountId} must exist before browser identity registration`);
      if (account.account.platform !== normalized.platform) {
        throw new BrowserIdentityConflictError(`Browser identity platform ${normalized.platform} does not match account ${account.account.platform}`);
      }
      if (normalizeSocialHandle(account.account.expectedHandle) !== normalized.expectedHandle) {
        throw new BrowserIdentityConflictError("Browser identity expectedHandle does not match social account expectedHandle");
      }
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/.test(normalized.profileKey) || normalized.profileKey.includes("..")) {
        throw new BrowserIdentityConflictError(`Unsafe browser profile key: ${normalized.profileKey}`);
      }

      const existingRow = this.db.prepare("SELECT * FROM browser_identities WHERE identity_id = ?").get(identity.identityId) as BrowserIdentityRow | undefined;
      if (existingRow) {
        const existing = browserIdentityFromRow(existingRow);
        if (!sameBrowserIdentity(existing.identity, normalized)) {
          throw new BrowserIdentityConflictError(`Browser identity ${identity.identityId} already exists with different configuration`);
        }
        return { created: false, record: existing };
      }
      const profileOwner = this.db.prepare("SELECT * FROM browser_identities WHERE profile_key = ?").get(normalized.profileKey) as BrowserIdentityRow | undefined;
      if (profileOwner) throw new BrowserIdentityConflictError(`Browser profile ${normalized.profileKey} already belongs to ${profileOwner.identity_id}`);
      const accountOwner = this.db.prepare("SELECT * FROM browser_identities WHERE account_id = ?").get(normalized.accountId) as BrowserIdentityRow | undefined;
      if (accountOwner) throw new BrowserIdentityConflictError(`Social account ${normalized.accountId} already has browser identity ${accountOwner.identity_id}`);

      const timestamp = asIso(now);
      this.db.prepare(`
        INSERT INTO browser_identities(identity_id, account_id, platform, profile_key, expected_handle, enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        normalized.identityId, normalized.accountId, normalized.platform, normalized.profileKey,
        normalized.expectedHandle, normalized.enabled ? 1 : 0, timestamp, timestamp
      );
      this.appendEvent({
        aggregateType: "browser_identity", aggregateId: normalized.identityId, eventType: "browser_identity.registered",
        occurredAt: timestamp, actor, payload: { accountId: normalized.accountId, platform: normalized.platform, profileKey: normalized.profileKey }
      });
      return { created: true, record: this.getBrowserIdentity(normalized.identityId)! };
    });
  }

  getBrowserIdentity(identityId: string): StoredBrowserIdentity | null {
    const row = this.db.prepare("SELECT * FROM browser_identities WHERE identity_id = ?").get(identityId) as BrowserIdentityRow | undefined;
    return row ? browserIdentityFromRow(row) : null;
  }

  listBrowserIdentities(): readonly StoredBrowserIdentity[] {
    return (this.db.prepare("SELECT * FROM browser_identities ORDER BY identity_id").all() as BrowserIdentityRow[]).map(browserIdentityFromRow);
  }

  recordSessionHealth(check: SessionHealthCheck, actor: Actor): SessionHealthCheck {
    return this.transaction(() => {
      const identity = this.getBrowserIdentity(check.identityId);
      if (!identity) throw new BrowserIdentityConflictError(`Unknown browser identity: ${check.identityId}`);
      const normalizedExpected = normalizeSocialHandle(check.expectedHandle);
      if (normalizedExpected !== normalizeSocialHandle(identity.identity.expectedHandle)) {
        throw new BrowserIdentityConflictError("Session health expectedHandle does not match browser identity");
      }
      const normalizedObserved = check.observedHandle ? normalizeSocialHandle(check.observedHandle) : undefined;
      const normalized: SessionHealthCheck = {
        ...check,
        checkedAt: asIso(check.checkedAt),
        expectedHandle: normalizedExpected,
        ...(normalizedObserved ? { observedHandle: normalizedObserved } : {})
      };
      this.db.prepare(`
        INSERT INTO session_health_checks(check_id, identity_id, checked_at, state, expected_handle, observed_handle, current_url, note)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        normalized.checkId, normalized.identityId, normalized.checkedAt, normalized.state, normalized.expectedHandle,
        normalized.observedHandle ?? null, normalized.currentUrl ?? null, normalized.note ?? null
      );
      this.appendEvent({
        aggregateType: "session_health", aggregateId: normalized.identityId, eventType: "session_health.checked",
        occurredAt: normalized.checkedAt, actor, payload: { state: normalized.state, observedHandle: normalized.observedHandle ?? null }
      });
      return normalized;
    });
  }

  latestSessionHealth(identityId: string): SessionHealthCheck | null {
    const row = this.db.prepare(`
      SELECT * FROM session_health_checks WHERE identity_id = ? ORDER BY checked_at DESC, sequence DESC LIMIT 1
    `).get(identityId) as SessionHealthRow | undefined;
    return row ? sessionHealthFromRow(row) : null;
  }

  listSessionHealth(identityId?: string): readonly SessionHealthCheck[] {
    const rows = identityId
      ? this.db.prepare("SELECT * FROM session_health_checks WHERE identity_id = ? ORDER BY checked_at, sequence").all(identityId) as SessionHealthRow[]
      : this.db.prepare("SELECT * FROM session_health_checks ORDER BY checked_at, sequence").all() as SessionHealthRow[];
    return rows.map(sessionHealthFromRow);
  }

  recordCapabilityProbe(probe: PlatformCapabilityProbe, actor: Actor): PlatformCapabilityProbe {
    return this.transaction(() => {
      const account = this.getSocialAccount(probe.accountId);
      const identity = this.getBrowserIdentity(probe.identityId);
      if (!account) throw new SocialAccountConflictError(`Unknown social account: ${probe.accountId}`);
      if (!identity) throw new BrowserIdentityConflictError(`Unknown browser identity: ${probe.identityId}`);
      if (identity.identity.accountId !== probe.accountId || account.account.platform !== probe.platform || identity.identity.platform !== probe.platform) {
        throw new BrowserIdentityConflictError("Capability probe account/identity/platform mismatch");
      }
      const normalized: PlatformCapabilityProbe = { ...probe, probedAt: asIso(probe.probedAt) };
      this.db.prepare(`
        INSERT INTO platform_capability_probes(
          probe_id, account_id, identity_id, platform, probed_at, capabilities_json, current_url, note
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        normalized.probeId, normalized.accountId, normalized.identityId, normalized.platform, normalized.probedAt,
        JSON.stringify(normalized.capabilities), normalized.currentUrl ?? null, normalized.note ?? null
      );
      this.appendEvent({
        aggregateType: "platform_capability", aggregateId: normalized.accountId, eventType: "platform_capability.probed",
        occurredAt: normalized.probedAt, actor, payload: { identityId: normalized.identityId, platform: normalized.platform, capabilities: normalized.capabilities }
      });
      return normalized;
    });
  }

  latestCapabilityProbe(accountId: string): PlatformCapabilityProbe | null {
    const row = this.db.prepare(`
      SELECT * FROM platform_capability_probes WHERE account_id = ? ORDER BY probed_at DESC, sequence DESC LIMIT 1
    `).get(accountId) as PlatformCapabilityProbeRow | undefined;
    return row ? platformCapabilityProbeFromRow(row) : null;
  }

  listCapabilityProbes(accountId?: string): readonly PlatformCapabilityProbe[] {
    const rows = accountId
      ? this.db.prepare("SELECT * FROM platform_capability_probes WHERE account_id = ? ORDER BY probed_at, sequence").all(accountId) as PlatformCapabilityProbeRow[]
      : this.db.prepare("SELECT * FROM platform_capability_probes ORDER BY probed_at, sequence").all() as PlatformCapabilityProbeRow[];
    return rows.map(platformCapabilityProbeFromRow);
  }

}
