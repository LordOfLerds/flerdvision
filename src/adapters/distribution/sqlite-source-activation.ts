import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { SourceActivationBaselineStorePort, SourceActivationBaseline, StoredSourceActivationBaseline } from "../../domain/source-lane-runtime.js";

interface BaselineRow {
  lane_id: string;
  cursor_fingerprint: string;
  baseline_json: string;
  payload_hash: string;
  created_at: string;
}

function iso(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid timestamp: ${value}`);
  return date.toISOString();
}
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function payload(baseline: SourceActivationBaseline): string {
  return JSON.stringify({ ...baseline, externalObjectIds: [...baseline.externalObjectIds].sort() });
}

export class SourceActivationBaselineConflictError extends Error {}

export class SqliteSourceActivationBaselineStore implements SourceActivationBaselineStorePort {
  private readonly db: DatabaseSync;
  constructor(databasePath: string) {
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS source_activation_baselines(
        lane_id TEXT NOT NULL,
        cursor_fingerprint TEXT NOT NULL,
        baseline_json TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(lane_id,cursor_fingerprint)
      );
      CREATE TRIGGER IF NOT EXISTS source_activation_baselines_no_update BEFORE UPDATE ON source_activation_baselines BEGIN SELECT RAISE(ABORT,'source_activation_baselines is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS source_activation_baselines_no_delete BEFORE DELETE ON source_activation_baselines BEGIN SELECT RAISE(ABORT,'source_activation_baselines is append-only'); END;
    `);
  }

  putBaseline(baseline: SourceActivationBaseline, now: string): { created: boolean; record: StoredSourceActivationBaseline } {
    const normalized = { ...baseline, externalObjectIds: [...new Set(baseline.externalObjectIds)].sort() };
    const text = payload(normalized);
    const digest = hash(text);
    const existing = this.db.prepare("SELECT * FROM source_activation_baselines WHERE lane_id=? AND cursor_fingerprint=?")
      .get(normalized.laneId, normalized.cursorFingerprint) as BaselineRow | undefined;
    if (existing) {
      if (existing.payload_hash !== digest || existing.baseline_json !== text) {
        throw new SourceActivationBaselineConflictError(`Activation baseline for ${baseline.laneId} changed after capture`);
      }
      return { created: false, record: { baseline: JSON.parse(existing.baseline_json) as SourceActivationBaseline, createdAt: existing.created_at } };
    }
    const createdAt = iso(now);
    this.db.prepare("INSERT INTO source_activation_baselines(lane_id,cursor_fingerprint,baseline_json,payload_hash,created_at) VALUES (?,?,?,?,?)")
      .run(normalized.laneId, normalized.cursorFingerprint, text, digest, createdAt);
    return { created: true, record: { baseline: normalized, createdAt } };
  }

  getBaseline(laneId: string, cursorFingerprint: string): StoredSourceActivationBaseline | null {
    const row = this.db.prepare("SELECT * FROM source_activation_baselines WHERE lane_id=? AND cursor_fingerprint=?")
      .get(laneId, cursorFingerprint) as BaselineRow | undefined;
    return row ? { baseline: JSON.parse(row.baseline_json) as SourceActivationBaseline, createdAt: row.created_at } : null;
  }

  close(): void { this.db.close(); }
}
