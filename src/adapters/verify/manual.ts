import type { Actor } from "../../domain/control-plane.js";
import type { PublicationIntentStorePort } from "../../domain/control-plane-ports.js";
import type { VerificationEvidence } from "../../domain/model.js";
import type { PublishAttemptStorePort, VerificationArtifactSinkPort, VerificationStorePort } from "../../domain/verification-ports.js";

export class ManualVerificationError extends Error {}

type ManualStore = PublicationIntentStorePort & PublishAttemptStorePort & VerificationStorePort;

function id(prefix: string, intentId: string, attemptId: string, now: string): string {
  return `${prefix}:${intentId}:${attemptId}:${new Date(now).getTime().toString(36)}:${Math.random().toString(36).slice(2, 9)}`;
}

export class ManualVerifierAdapter {
  constructor(
    private readonly store: ManualStore,
    private readonly artifacts?: VerificationArtifactSinkPort,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  async confirmPublished(
    intentId: string,
    attemptId: string,
    actor: Actor,
    options: { permalink?: string; note?: string } = {}
  ): Promise<readonly VerificationEvidence[]> {
    if (actor.type !== "operator" && actor.type !== "test") throw new ManualVerificationError("Manual verification requires an operator actor");
    const intent = this.store.getIntent(intentId)?.intent;
    const attempt = this.store.getPublishAttempt(attemptId);
    if (!intent || !attempt || attempt.intentId !== intentId) throw new ManualVerificationError("Unknown intent/attempt");
    const now = this.now();
    const artifactRef = this.artifacts
      ? await this.artifacts.writeManualEvidence(intent, attempt, { outcome: "published", ...options, actor }, now)
      : undefined;
    const evidence: VerificationEvidence[] = [{
      evidenceId: id("manual-positive", intentId, attemptId, now),
      intentId,
      attemptId,
      kind: "manual_confirmation",
      observedAt: now,
      positive: true,
      ...(artifactRef ? { artifactRef } : {}),
      ...(options.note ? { note: options.note } : {})
    }];
    if (options.permalink) {
      evidence.push({
        evidenceId: id("manual-profile", intentId, attemptId, now),
        intentId,
        attemptId,
        kind: "profile_permalink",
        observedAt: now,
        positive: true,
        locator: options.permalink,
        ...(artifactRef ? { artifactRef } : {}),
        note: "permalink supplied by authorized manual verifier"
      });
    }
    return evidence.map((item) => this.store.recordVerificationEvidence(item, actor));
  }

  async confirmNotPublished(intentId: string, attemptId: string, actor: Actor, note: string): Promise<VerificationEvidence> {
    if (actor.type !== "operator" && actor.type !== "test") throw new ManualVerificationError("Manual verification requires an operator actor");
    if (!note.trim()) throw new ManualVerificationError("Manual negative verification requires a note");
    const intent = this.store.getIntent(intentId)?.intent;
    const attempt = this.store.getPublishAttempt(attemptId);
    if (!intent || !attempt || attempt.intentId !== intentId) throw new ManualVerificationError("Unknown intent/attempt");
    const now = this.now();
    const artifactRef = this.artifacts
      ? await this.artifacts.writeManualEvidence(intent, attempt, { outcome: "not_published", note, actor }, now)
      : undefined;
    return this.store.recordVerificationEvidence({
      evidenceId: id("manual-negative", intentId, attemptId, now),
      intentId,
      attemptId,
      kind: "manual_not_published",
      observedAt: now,
      positive: false,
      note,
      ...(artifactRef ? { artifactRef } : {})
    }, actor);
  }
}
