// Regenerates tests/fixtures/w1-migration-1.sqlite.
//
// The upgrade tests need a database that stopped at migration 1, so that opening it under the
// current build genuinely exercises the migration path. Migration 1 is frozen history, so its DDL
// is reproduced here verbatim rather than derived from the current store, which would always
// produce a fully-migrated database and make the tests assert nothing.
//
// Run with: node tests/fixtures/make-w1-fixture.mjs
import { DatabaseSync } from "node:sqlite";
import { rmSync } from "node:fs";

export const MIGRATION_ONE_DDL = `
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
`;

export function writeMigrationOneDatabase(path) {
  rmSync(path, { force: true });
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
    db.exec(MIGRATION_ONE_DDL);
    db.prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)")
      .run(1, "initial durable control plane", "2026-08-26T00:00:00.000Z");
  } finally {
    db.close();
  }
  return path;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const target = new URL("./w1-migration-1.sqlite", import.meta.url).pathname;
  writeMigrationOneDatabase(target);
  console.log(`wrote ${target}`);
}
