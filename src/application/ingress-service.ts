import { createHash } from "node:crypto";
import type { Actor } from "../domain/control-plane.js";
import type { IngressRunReport, StoredContentItem } from "../domain/ingress.js";
import type { IngressStorePort } from "../domain/ingress-ports.js";
import type { ContentItem, Instant, SourceObservation } from "../domain/model.js";
import type { ContentIngressPort, IngressInterpreterPort, SourceDispositionPort } from "../domain/ports.js";

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function contentIdFor(observation: SourceObservation): string {
  if (!observation.mediaFingerprint) throw new Error("Cannot create content without media fingerprint");
  return `content:${sha256(`${observation.sourceId}\n${observation.externalObjectId}\n${observation.mediaFingerprint}`).slice(0, 32)}`;
}

function contentFromAcceptedObservation(
  observation: SourceObservation,
  creatorId: string,
  scheduledBusinessDate?: string,
  formatHints?: readonly string[]
): ContentItem {
  if (!observation.mediaFingerprint) {
    throw new Error(`Source observation ${observation.observationId} has no immutable media fingerprint`);
  }
  const metadata: Record<string, string> = {
    ...observation.metadata,
    sourceId: observation.sourceId,
    externalObjectId: observation.externalObjectId
  };
  if (formatHints && formatHints.length > 0) metadata.formatHints = formatHints.join(",");

  const item: ContentItem = {
    contentId: contentIdFor(observation),
    acceptedFromObservationId: observation.observationId,
    creatorId,
    mediaFingerprint: observation.mediaFingerprint,
    immutableMediaRef: observation.locator,
    metadata
  };
  if (scheduledBusinessDate) Object.assign(item, { scheduledBusinessDate });
  return item;
}

export interface IngressServiceOptions {
  notifyBlocksExternally?: boolean;
}

export class ContentIngressService {
  constructor(
    private readonly source: ContentIngressPort,
    private readonly interpreter: IngressInterpreterPort,
    private readonly store: IngressStorePort,
    private readonly disposition: SourceDispositionPort,
    private readonly options: IngressServiceOptions = {}
  ) {}

  async run(now: Instant, actor: Actor = { type: "system", id: "content-ingress" }): Promise<IngressRunReport> {
    const observations = await this.source.observe();
    const report = {
      observed: observations.length,
      createdObservations: 0,
      duplicateObservations: 0,
      accepted: 0,
      ignored: 0,
      blocked: 0,
      conflicts: 0,
      createdContentItems: 0,
      existingContentItems: 0
    };

    for (const observation of observations) {
      const persisted = this.store.observeOrGetSource(observation, now, actor);
      if (persisted.status === "conflict") {
        report.conflicts += 1;
        report.blocked += 1;
        await this.ensureExternalBlock(
          persisted.record.observation.observationId,
          persisted.reason,
          now,
          actor
        );
        continue;
      }
      if (persisted.status === "duplicate") {
        report.duplicateObservations += 1;
        if (persisted.record.state === "BLOCKED" && persisted.record.reason) {
          await this.ensureExternalBlock(
            persisted.record.observation.observationId,
            persisted.record.reason,
            now,
            actor
          );
        }
        continue;
      }
      report.createdObservations += 1;

      const decision = await this.interpreter.interpret(observation);
      if (decision.observationId !== observation.observationId) {
        const reason = `Interpreter returned mismatched observation id ${decision.observationId}`;
        this.store.decideSourceObservation(observation.observationId, "BLOCKED", now, actor, { reason });
        report.blocked += 1;
        await this.ensureExternalBlock(observation.observationId, reason, now, actor);
        continue;
      }

      if (decision.decision === "ignore") {
        this.store.decideSourceObservation(observation.observationId, "IGNORED", now, actor, {
          reason: decision.reason ?? "ignored_by_interpreter"
        });
        report.ignored += 1;
        continue;
      }

      if (decision.decision === "block") {
        const reason = decision.reason ?? "blocked_by_interpreter";
        this.store.decideSourceObservation(observation.observationId, "BLOCKED", now, actor, { reason });
        report.blocked += 1;
        await this.ensureExternalBlock(observation.observationId, reason, now, actor);
        continue;
      }

      if (!decision.creatorId) {
        const reason = "Accepted ingress decision is missing creatorId";
        this.store.decideSourceObservation(observation.observationId, "BLOCKED", now, actor, { reason });
        report.blocked += 1;
        await this.ensureExternalBlock(observation.observationId, reason, now, actor);
        continue;
      }

      if (!observation.mediaFingerprint) {
        const reason = "Source media fingerprint unavailable; immutable content cannot be proven";
        this.store.decideSourceObservation(observation.observationId, "BLOCKED", now, actor, { reason });
        report.blocked += 1;
        await this.ensureExternalBlock(observation.observationId, reason, now, actor);
        continue;
      }

      const item = contentFromAcceptedObservation(
        observation,
        decision.creatorId,
        decision.scheduledBusinessDate,
        decision.formatHints
      );
      const content = this.store.createOrGetContent(item, now, actor);
      if (content.created) report.createdContentItems += 1;
      else report.existingContentItems += 1;
      this.store.decideSourceObservation(observation.observationId, "ACCEPTED", now, actor, {
        contentId: content.record.item.contentId
      });
      report.accepted += 1;
    }

    return report;
  }

  private async ensureExternalBlock(
    sourceObservationId: string,
    reason: string,
    now: Instant,
    actor: Actor
  ): Promise<void> {
    if (!this.options.notifyBlocksExternally) return;
    const existing = this.store.getSourceDisposition(sourceObservationId);
    if (existing?.state === "BLOCKED") return;
    if (existing) throw new Error(`Source ${sourceObservationId} already has disposition ${existing.state}`);
    await this.disposition.markBlocked(sourceObservationId, reason);
    this.store.recordSourceDisposition(
      { sourceObservationId, state: "BLOCKED", publicationIds: [], reason, updatedAt: now },
      actor
    );
  }
}

export class SourceAcknowledgementService {
  constructor(
    private readonly store: IngressStorePort,
    private readonly disposition: SourceDispositionPort
  ) {}

  async complete(
    sourceObservationId: string,
    publicationIds: readonly string[],
    now: Instant,
    actor: Actor = { type: "system", id: "source-acknowledgement" }
  ): Promise<void> {
    const existing = this.store.getSourceDisposition(sourceObservationId);
    const normalized = [...publicationIds].sort();
    if (
      existing?.state === "COMPLETED" &&
      JSON.stringify([...existing.publicationIds].sort()) === JSON.stringify(normalized)
    ) return;
    if (existing) throw new Error(`Source ${sourceObservationId} already has disposition ${existing.state}`);

    await this.disposition.markCompleted(sourceObservationId, normalized);
    this.store.recordSourceDisposition(
      { sourceObservationId, state: "COMPLETED", publicationIds: normalized, updatedAt: now },
      actor
    );
  }

  async block(
    sourceObservationId: string,
    reason: string,
    now: Instant,
    actor: Actor = { type: "system", id: "source-acknowledgement" }
  ): Promise<void> {
    const existing = this.store.getSourceDisposition(sourceObservationId);
    if (existing?.state === "BLOCKED" && existing.reason === reason) return;
    if (existing) throw new Error(`Source ${sourceObservationId} already has disposition ${existing.state}`);

    await this.disposition.markBlocked(sourceObservationId, reason);
    this.store.recordSourceDisposition(
      { sourceObservationId, state: "BLOCKED", publicationIds: [], reason, updatedAt: now },
      actor
    );
  }
}

export function contentForObservation(store: IngressStorePort, observationId: string): StoredContentItem | null {
  const observation = store.getSourceObservation(observationId);
  return observation?.contentId ? store.getContentItem(observation.contentId) : null;
}
