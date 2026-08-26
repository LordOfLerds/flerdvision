import type { PublicationIntent } from "./model.js";
import type { PublishContext } from "./ports.js";

export class PublishGateError extends Error {}

export function assertFinalPublishAllowed(intent: PublicationIntent, context: PublishContext): void {
  if (!context.allowFinalPublish) throw new PublishGateError("Final publish hard gate is disabled");
  if (context.mode === "disabled" || context.mode === "prepare_only") {
    throw new PublishGateError(`Mode ${context.mode} forbids final publish`);
  }
  if (!context.allowedAccountIds.has(intent.accountId)) {
    throw new PublishGateError(`Account ${intent.accountId} is not in the publish allowlist`);
  }
}
