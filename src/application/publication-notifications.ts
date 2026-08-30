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
  timeZone?: string;
  /** Spec display name of the channel (customer-facing); falls back to the bare handle. */
  channelName?: string;
}

const PLATFORM_LABEL: Readonly<Record<string, string>> = { instagram: "Instagram", tiktok: "TikTok", youtube: "YouTube" };

function platformLabel(platform: string): string {
  return PLATFORM_LABEL[platform] ?? platform;
}

function localTime(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("de-AT", { hour: "2-digit", minute: "2-digit", timeZone }).format(new Date(iso));
  } catch {
    return iso.slice(11, 16);
  }
}

function handleFrom(accountId: string): string {
  const tail = accountId.split(":").at(-1) ?? accountId;
  return tail.replace(/^instagram-|^tiktok-|^youtube-/, "");
}

export function publicationOutcomeMessage(input: PublicationOutcomeNotificationInput, now: string): NotificationMessage {
  const verified = input.outcome === "VERIFIED";
  const handle = input.channelName ?? handleFrom(input.intent.accountId);
  const timeZone = input.timeZone ?? "Europe/Vienna";
  // Operator requirement: every message names time, channel and platform up front.
  const slot = localTime(input.intent.scheduledFor, timeZone);
  const subject = verified
    ? `Post verifiziert · ${slot} · ${handle} · ${platformLabel(input.intent.platform)}`
    : `Post UNSICHER · ${slot} · ${handle} · ${platformLabel(input.intent.platform)}`;
  const body = verified
    ? `${platformLabel(input.intent.platform)} · ${input.intent.format} · ${slot} Uhr ist live und verifiziert.`
    : `${platformLabel(input.intent.platform)} · ${input.intent.format} · ${slot} Uhr: Klick erfolgt, Publikation nicht bestätigt. Posten für diesen Intent ist eingefroren — kein automatischer Neuversuch.`;
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

/**
 * Wave bundling: several channels often post in the same slot; the operator hears ONE message
 * per wave instead of one ping per platform. Single-outcome groups keep the detailed single
 * message; failures always stay individually loud.
 */
export function publicationWaveMessage(outcomes: readonly PublicationOutcomeNotificationInput[], now: string): NotificationMessage {
  const first = outcomes[0]!;
  const timeZone = first.timeZone ?? "Europe/Vienna";
  const slot = localTime(first.intent.scheduledFor, timeZone);
  const lines = outcomes.map((item) => {
    const badge = item.outcome === "VERIFIED" ? "✅" : "🛑";
    const link = item.permalink ? ` — ${item.permalink}` : "";
    return `${badge} ${item.channelName ?? handleFrom(item.intent.accountId)} · ${platformLabel(item.intent.platform)}${link}`;
  });
  const allVerified = outcomes.every((item) => item.outcome === "VERIFIED");
  const screenshot = outcomes.find((item) => item.screenshotPath)?.screenshotPath;
  return {
    notificationId: `publication-wave:${first.intent.scheduledFor}:${new Date(now).getTime().toString(36)}`,
    dedupeKey: `publication-wave:${first.intent.scheduledFor}:${outcomes.map((item) => item.intent.intentId).sort().join("|")}`,
    kind: "COMPLETION",
    severity: allVerified ? "INFO" : "ERROR",
    createdAt: new Date(now).toISOString(),
    subject: `${slot}-Welle · ${outcomes.length} Posts${allVerified ? " verifiziert" : " · mit Problemen"}`,
    body: lines.join("\n"),
    metadata: {
      ...(screenshot ? { screenshotPath: screenshot } : {})
    }
  };
}

/** Groups a cycle's outcomes by slot time; waves of one fall back to the detailed message. */
export async function notifyPublicationOutcomes(
  outbox: NotificationOutboxPort,
  adapters: readonly NotificationPort[],
  outcomes: readonly PublicationOutcomeNotificationInput[],
  now: string,
  actor: Actor
): Promise<void> {
  if (adapters.length === 0 || outcomes.length === 0) return;
  const groups = new Map<string, PublicationOutcomeNotificationInput[]>();
  for (const outcome of outcomes) {
    const key = outcome.intent.scheduledFor;
    groups.set(key, [...(groups.get(key) ?? []), outcome]);
  }
  try {
    for (const group of groups.values()) {
      if (group.length === 1) {
        outbox.enqueueNotification(publicationOutcomeMessage(group[0]!, now), adapters.map((adapter) => adapter.channelKey), actor);
      } else {
        outbox.enqueueNotification(publicationWaveMessage(group, now), adapters.map((adapter) => adapter.channelKey), actor);
      }
    }
    await new NotificationDispatcher(outbox, adapters).dispatchPending(new Date(now).toISOString(), actor);
  } catch {
    // Delivery belongs to the retrying outbox; reporting must never break the worker.
  }
}
