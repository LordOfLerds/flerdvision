import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { DistributionProvenanceStorePort } from "../../domain/distribution-provenance-ports.js";
import type {
  DailyPlanProvenance,
  DistributionPublicationIntentEnvelope,
  StoredDailyPlanProvenance,
  StoredDistributionIntentEnvelope
} from "../../domain/distribution-provenance.js";

interface PlanRow { plan_id: string; provenance_json: string; payload_hash: string; created_at: string; }
interface IntentRow { intent_id: string; delivery_id: string; envelope_json: string; payload_hash: string; created_at: string; }

function iso(value: string): string { const parsed = new Date(value); if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid timestamp: ${value}`); return parsed.toISOString(); }
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function json(value: unknown): string { return JSON.stringify(value); }

export class DistributionProvenanceConflictError extends Error {}

export class SqliteDistributionProvenanceStore implements DistributionProvenanceStorePort {
  private readonly db: DatabaseSync;
  constructor(databasePath: string) {
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS distribution_plan_provenance (
        plan_id TEXT PRIMARY KEY, provenance_json TEXT NOT NULL, payload_hash TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS distribution_intent_provenance (
        intent_id TEXT PRIMARY KEY, delivery_id TEXT NOT NULL UNIQUE, envelope_json TEXT NOT NULL, payload_hash TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS distribution_plan_provenance_no_update BEFORE UPDATE ON distribution_plan_provenance BEGIN SELECT RAISE(ABORT, 'distribution_plan_provenance is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS distribution_plan_provenance_no_delete BEFORE DELETE ON distribution_plan_provenance BEGIN SELECT RAISE(ABORT, 'distribution_plan_provenance is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS distribution_intent_provenance_no_update BEFORE UPDATE ON distribution_intent_provenance BEGIN SELECT RAISE(ABORT, 'distribution_intent_provenance is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS distribution_intent_provenance_no_delete BEFORE DELETE ON distribution_intent_provenance BEGIN SELECT RAISE(ABORT, 'distribution_intent_provenance is append-only'); END;
    `);
  }

  putPlan(provenance: DailyPlanProvenance, now: string): { created: boolean; record: StoredDailyPlanProvenance } {
    const payload = json(provenance);
    const semanticPayload = json({ planId: provenance.planId, businessDate: provenance.businessDate, routeSnapshots: provenance.routeSnapshots });
    const digest = hash(semanticPayload);
    const existing = this.db.prepare("SELECT * FROM distribution_plan_provenance WHERE plan_id = ?").get(provenance.planId) as PlanRow | undefined;
    if (existing) {
      const parsed = JSON.parse(existing.provenance_json) as DailyPlanProvenance;
      const existingSemantic = json({ planId: parsed.planId, businessDate: parsed.businessDate, routeSnapshots: parsed.routeSnapshots });
      if (existing.payload_hash !== hash(existingSemantic) || existing.payload_hash !== digest) throw new DistributionProvenanceConflictError(`DailyPlan ${provenance.planId} already has different provenance`);
      return { created: false, record: { provenance: parsed, createdAt: existing.created_at } };
    }
    const createdAt = iso(now);
    this.db.prepare("INSERT INTO distribution_plan_provenance(plan_id, provenance_json, payload_hash, created_at) VALUES (?, ?, ?, ?)").run(provenance.planId, payload, digest, createdAt);
    return { created: true, record: { provenance, createdAt } };
  }

  getPlan(planId: string): StoredDailyPlanProvenance | null {
    const row = this.db.prepare("SELECT * FROM distribution_plan_provenance WHERE plan_id = ?").get(planId) as PlanRow | undefined;
    return row ? { provenance: JSON.parse(row.provenance_json) as DailyPlanProvenance, createdAt: row.created_at } : null;
  }

  putIntent(envelope: DistributionPublicationIntentEnvelope, now: string): { created: boolean; record: StoredDistributionIntentEnvelope } {
    const payload = json(envelope), digest = hash(payload);
    const existingByIntent = this.db.prepare("SELECT * FROM distribution_intent_provenance WHERE intent_id = ?").get(envelope.intent.intentId) as IntentRow | undefined;
    if (existingByIntent) {
      if (existingByIntent.payload_hash !== digest || existingByIntent.envelope_json !== payload) throw new DistributionProvenanceConflictError(`Intent ${envelope.intent.intentId} already has different distribution provenance`);
      return { created: false, record: { envelope: JSON.parse(existingByIntent.envelope_json) as DistributionPublicationIntentEnvelope, createdAt: existingByIntent.created_at } };
    }
    const existingByDelivery = this.db.prepare("SELECT * FROM distribution_intent_provenance WHERE delivery_id = ?").get(envelope.provenance.deliveryId) as IntentRow | undefined;
    if (existingByDelivery) throw new DistributionProvenanceConflictError(`Delivery ${envelope.provenance.deliveryId} is already mapped to intent ${existingByDelivery.intent_id}`);
    const createdAt = iso(now);
    this.db.prepare("INSERT INTO distribution_intent_provenance(intent_id, delivery_id, envelope_json, payload_hash, created_at) VALUES (?, ?, ?, ?, ?)").run(envelope.intent.intentId, envelope.provenance.deliveryId, payload, digest, createdAt);
    return { created: true, record: { envelope, createdAt } };
  }

  getIntent(intentId: string): StoredDistributionIntentEnvelope | null {
    const row = this.db.prepare("SELECT * FROM distribution_intent_provenance WHERE intent_id = ?").get(intentId) as IntentRow | undefined;
    return row ? { envelope: JSON.parse(row.envelope_json) as DistributionPublicationIntentEnvelope, createdAt: row.created_at } : null;
  }
  getIntentByDelivery(deliveryId: string): StoredDistributionIntentEnvelope | null {
    const row = this.db.prepare("SELECT * FROM distribution_intent_provenance WHERE delivery_id = ?").get(deliveryId) as IntentRow | undefined;
    return row ? { envelope: JSON.parse(row.envelope_json) as DistributionPublicationIntentEnvelope, createdAt: row.created_at } : null;
  }
  close(): void { this.db.close(); }
}
