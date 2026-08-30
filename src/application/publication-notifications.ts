import type { Actor } from "../domain/control-plane.js";
import type { PublicationIntent } from "../domain/model.js";
import type { NotificationOutboxPort, NotificationPort } from "../domain/operations-ports.js";
import type { NotificationMessage } from "../domain/operations.js";
import { NotificationDispatcher } from "./notifications.js";

export interface PublicationOutcomeNotificationInput {
  intent: PublicationIntent;
  runId: string;
  outcome: "VERIFIED" | "UNCERTAIN";
  permalink?: string;
  screenshotPath?: string;
}

function handleFrom(accountId: string): string {
  const tail = accountId.split(":").at(-1) ?? accountId;
  return tail.replace(/^instagram-|^tiktok-|^youtube-/, "");
}

export function publicationOutcomeMessage(input: PublicationOutcomeNotificationInput, now: string): NotificationMessage {
  const verified = input.outcome === "VERIFIED";
  const handle = handleFrom(input.intent.accountId);
  const subject = verified ? `Post verifiziert · ${handle}` : `Post UNSICHER · ${handle}`;
  const body = verified
    ? `${input.intent.platform} · ${input.intent.format} ist live und verifiziert.`
    : `${input.intent.platform} · ${input.intent.format}: Klick erfolgt, Publikation nicht bestätigt. Posten für diesen Intent ist eingefroren — kein automatischer Neuversuch.`;
  return {
    notificationId: `publication:${input.intent.intentId}:${input.outcome}:${new Date(now).getTime().toString(36)}`,
    dedupeKey: `publication:${input.intent.intentId}:${input.outcome}`,
    kind: "COMPLETION",
    severity: verified ? "INFO" : "ERROR",
    createdAt: new Date(now).toISOString(),
    subject,
    body,
    intentId: input.intent.intentId,
    accountId: input.intent.accountId,
    metadata: {
      runId: input.runId,
      ...(input.permalink ? { permalink: input.permalink } : {}),
      ...(input.screenshotPath ? { screenshotPath: input.screenshotPath } : {})
    }
  };
}

/**
 * Durably enqueues the outcome message for every configured adapter, then attempts immediate
 * dispatch. Delivery failures stay in the outbox for the retrying dispatcher; notification
 * problems never break the verification path that calls this.
 */
export async function notifyPublicationOutcome(
  outbox: NotificationOutboxPort,
  adapters: readonly NotificationPort[],
  input: PublicationOutcomeNotificationInput,
  now: string,
  actor: Actor
): Promise<void> {
  if (adapters.length === 0) return;
  try {
    const message = publicationOutcomeMessage(input, now);
    outbox.enqueueNotification(message, adapters.map((adapter) => adapter.channelKey), actor);
    await new NotificationDispatcher(outbox, adapters).dispatchPending(new Date(now).toISOString(), actor);
  } catch {
    // The outbox retry loop owns delivery; verification must not fail because a message could not.
  }
}
