import type { Actor } from "../domain/control-plane.js";
import type { PublicationIntent } from "../domain/model.js";
import type { NotificationOutboxPort, NotificationPort } from "../domain/operations-ports.js";
import type { NotificationMessage } from "../domain/operations.js";
import { NotificationDispatcher } from "./notifications.js";
import {
  germanDayLabel,
  germanFormatLabel,
  germanPlatformLabel,
  renderOperatorMessage,
  type OperatorMessageContext,
  type OperatorNextSlot
} from "./operator-message.js";

export interface PublicationOutcomeNotificationInput {
  intent: PublicationIntent;
  runId: string;
  outcome: "VERIFIED" | "UNCERTAIN";
  permalink?: string;
  screenshotPath?: string;
  /** MP4 recording of the run (upload to boundary); sent as a Telegram video when present. */
  videoPath?: string;
  timeZone?: string;
  /** Spec display name of the channel (customer-facing); falls back to the bare handle. */
  channelName?: string;
  /** Caption wording from the Drive file name -- the name Luca knows this video by. */
  videoLabel?: string;
  /** Hashtag part of the Drive file name. */
  hashtags?: string;
  /** Caption exactly as posted. */
  caption?: string;
  /** Title exactly as posted (YouTube). */
  title?: string;
  /** German sentence naming what happened; only used for an uncertain or failed outcome. */
  reason?: string;
  /** German sentence naming the operator's next move on a failed wave entry. */
  nextStep?: string;
}

export interface PublicationWaveOptions {
  /** "⏭️ Als Nächstes: 12:00 · Reels, Clips" -- omitted when the day has nothing left. */
  nextSlot?: OperatorNextSlot;
}

function localTime(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("de-AT", { hour: "2-digit", minute: "2-digit", timeZone, hourCycle: "h23" }).format(new Date(iso));
  } catch {
    return iso.slice(11, 16);
  }
}

function localDay(iso: string, timeZone: string): string {
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
        .formatToParts(new Date(iso)).map((part) => [part.type, part.value])
    );
    return germanDayLabel(`${parts.year}-${parts.month}-${parts.day}`);
  } catch {
    return germanDayLabel(iso.slice(0, 10));
  }
}

function handleFrom(accountId: string): string {
  const tail = accountId.split(":").at(-1) ?? accountId;
  return tail.replace(/^instagram-|^tiktok-|^youtube-/, "");
}

/** One publication outcome as facts; the renderer owns every word the operator reads. */
function contextFor(input: PublicationOutcomeNotificationInput): OperatorMessageContext {
  const timeZone = input.timeZone ?? "Europe/Vienna";
  return {
    planLabel: `Tagesplan ${localDay(input.intent.scheduledFor, timeZone)}`,
    slotLocal: localTime(input.intent.scheduledFor, timeZone),
    channelName: input.channelName ?? handleFrom(input.intent.accountId),
    platformLabel: germanPlatformLabel(input.intent.platform),
    handle: handleFrom(input.intent.accountId),
    formatLabel: germanFormatLabel(input.intent.format),
    ok: input.outcome === "VERIFIED",
    runId: input.runId,
    ...(input.videoLabel ? { videoLabel: input.videoLabel } : {}),
    ...(input.hashtags ? { hashtags: input.hashtags } : {}),
    ...(input.caption ? { caption: input.caption } : {}),
    ...(input.title ? { title: input.title } : {}),
    ...(input.permalink ? { permalink: input.permalink } : {}),
    ...(input.screenshotPath ? { screenshotPath: input.screenshotPath } : {}),
    ...(input.videoPath ? { videoPath: input.videoPath } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.nextStep ? { nextStep: input.nextStep } : {})
  };
}

export function publicationOutcomeMessage(input: PublicationOutcomeNotificationInput, now: string): NotificationMessage {
  const verified = input.outcome === "VERIFIED";
  const rendered = renderOperatorMessage(verified ? "POST_VERIFIED" : "POST_UNCERTAIN", contextFor(input));
  return {
    notificationId: `publication:${input.intent.intentId}:${input.outcome}:${new Date(now).getTime().toString(36)}`,
    dedupeKey: `publication:${input.intent.intentId}:${input.outcome}`,
    kind: "COMPLETION",
    severity: verified ? "INFO" : "ERROR",
    createdAt: new Date(now).toISOString(),
    subject: rendered.subject,
    body: rendered.body,
    intentId: input.intent.intentId,
    accountId: input.intent.accountId,
    metadata: {
      runId: input.runId,
      ...(input.permalink ? { permalink: input.permalink} : {}),
      ...(input.screenshotPath ? { screenshotPath: input.screenshotPath } : {}),
      ...(input.videoPath ? { videoPath: input.videoPath } : {})
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
 * per wave instead of one ping per platform. Every outcome contributes its own line -- channel,
 * format, video, hashtags, link -- and every screenshot rides along as one album so the evidence
 * matches the text. Failures stay individually loud with reason and next step.
 */
export function publicationWaveMessage(
  outcomes: readonly PublicationOutcomeNotificationInput[],
  now: string,
  options: PublicationWaveOptions = {}
): NotificationMessage {
  const first = outcomes[0]!;
  const contexts = outcomes.map(contextFor);
  const header: OperatorMessageContext = { ...contexts[0]!, entries: contexts, ...(options.nextSlot ? { nextSlot: options.nextSlot } : {}) };
  const rendered = renderOperatorMessage("WAVE", header);
  const allVerified = outcomes.every((item) => item.outcome === "VERIFIED");
  const screenshots = outcomes.map((item) => item.screenshotPath).filter((path): path is string => Boolean(path));
  return {
    notificationId: `publication-wave:${first.intent.scheduledFor}:${new Date(now).getTime().toString(36)}`,
    dedupeKey: `publication-wave:${first.intent.scheduledFor}:${outcomes.map((item) => item.intent.intentId).sort().join("|")}`,
    kind: "COMPLETION",
    severity: allVerified ? "INFO" : "ERROR",
    createdAt: new Date(now).toISOString(),
    subject: rendered.subject,
    body: rendered.body,
    metadata: {
      ...(screenshots.length > 0 ? { screenshotPaths: screenshots.slice(0, 10) } : {}),
      ...(outcomes.find((item) => item.videoPath)?.videoPath ? { videoPath: outcomes.find((item) => item.videoPath)!.videoPath! } : {})
    }
  };
}

/** Groups a cycle's outcomes by slot time; waves of one fall back to the detailed message. */
export async function notifyPublicationOutcomes(
  outbox: NotificationOutboxPort,
  adapters: readonly NotificationPort[],
  outcomes: readonly PublicationOutcomeNotificationInput[],
  now: string,
  actor: Actor,
  options: PublicationWaveOptions = {}
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
        outbox.enqueueNotification(publicationWaveMessage(group, now, options), adapters.map((adapter) => adapter.channelKey), actor);
      }
    }
    await new NotificationDispatcher(outbox, adapters).dispatchPending(new Date(now).toISOString(), actor);
  } catch {
    // Delivery belongs to the retrying outbox; reporting must never break the worker.
  }
}
