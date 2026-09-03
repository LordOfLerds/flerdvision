import type { Instant, PublicationIntent } from "./model.js";
import type { ScheduleReservation } from "./control-plane.js";

export interface SlotDefinition {
  key: string;
  localTime: string; // HH:mm
}

export interface SchedulingPolicy {
  timeZone: "Europe/Vienna" | string;
  slots: readonly SlotDefinition[];
  windowMinutes: number;
  maxPerAccountPerBusinessDate: number;
  minimumSpacingMinutes: number;
  overflowAllowed: boolean;
  overflowMinimumSpacingMinutes: number;
  /**
   * Outage catch-up (operator decision, binding): a never-attempted intent whose on-time
   * window (scheduledFor +/- windowMinutes) has already closed may still be claimed until
   * scheduledFor + catchUpHours. Past that boundary it is waived, never published late.
   */
  catchUpHours: number;
}

export const DEFAULT_SCHEDULING_POLICY: SchedulingPolicy = {
  timeZone: "Europe/Vienna",
  slots: [
    { key: "slot-1", localTime: "09:00" },
    { key: "slot-2", localTime: "11:00" },
    { key: "slot-3", localTime: "15:00" },
    { key: "slot-4", localTime: "17:00" }
  ],
  windowMinutes: 30,
  maxPerAccountPerBusinessDate: 4,
  minimumSpacingMinutes: 120,
  overflowAllowed: false,
  overflowMinimumSpacingMinutes: 240,
  catchUpHours: 4
};

/** Transition reason for a SCHEDULED intent waived after its catch-up window elapsed unclaimed. */
export const MISSED_WINDOW_WAIVE_REASON = "Slot verpasst, Nachholfenster abgelaufen";

export class SchedulingPolicyError extends Error {}

function partsInZone(instant: Instant, timeZone: string): Record<string, string> {
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) throw new SchedulingPolicyError(`Invalid instant: ${instant}`);
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });
  const out: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") out[part.type] = part.value;
  }
  return out;
}

export function businessDateForInstant(instant: Instant, timeZone: string): string {
  const p = partsInZone(instant, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

export function localTimeForInstant(instant: Instant, timeZone: string): string {
  const p = partsInZone(instant, timeZone);
  return `${p.hour}:${p.minute}`;
}

function timeZoneOffsetMs(date: Date, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });
  const p: Record<string, number> = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") p[part.type] = Number(part.value);
  }
  const representedAsUtc = Date.UTC(p.year ?? 0, (p.month ?? 1) - 1, p.day ?? 1, p.hour ?? 0, p.minute ?? 0, p.second ?? 0);
  return representedAsUtc - date.getTime();
}

export function instantForLocalDateTime(businessDate: string, localTime: string, timeZone: string): Instant {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(businessDate);
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(localTime);
  if (!dateMatch || !timeMatch) throw new SchedulingPolicyError(`Invalid local date/time: ${businessDate} ${localTime}`);

  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  if (hour > 23 || minute > 59) throw new SchedulingPolicyError(`Invalid local time: ${localTime}`);

  const localAsUtcMs = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let guess = new Date(localAsUtcMs);
  for (let i = 0; i < 3; i += 1) {
    const offset = timeZoneOffsetMs(guess, timeZone);
    guess = new Date(localAsUtcMs - offset);
  }

  const candidate = guess.toISOString();
  if (businessDateForInstant(candidate, timeZone) !== businessDate || localTimeForInstant(candidate, timeZone) !== localTime) {
    throw new SchedulingPolicyError(`Local time does not resolve uniquely/safely in ${timeZone}: ${businessDate} ${localTime}`);
  }
  return candidate;
}

export function addMinutes(instant: Instant, minutes: number): Instant {
  const ms = new Date(instant).getTime();
  if (Number.isNaN(ms)) throw new SchedulingPolicyError(`Invalid instant: ${instant}`);
  return new Date(ms + minutes * 60_000).toISOString();
}

export function minutesBetween(a: Instant, b: Instant): number {
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) / 60_000;
}

/** End of the outage catch-up grace period for a slot: scheduledFor + policy.catchUpHours. */
export function catchUpWindowEndAt(scheduledFor: Instant, policy: SchedulingPolicy): Instant {
  return addMinutes(scheduledFor, policy.catchUpHours * 60);
}

/** True while `now` is still inside the catch-up grace period for a slot (inclusive of the edge). */
export function isWithinCatchUp(scheduledFor: Instant, policy: SchedulingPolicy, now: Instant): boolean {
  return new Date(now).getTime() <= new Date(catchUpWindowEndAt(scheduledFor, policy)).getTime();
}

export function matchingSlot(intent: PublicationIntent, policy: SchedulingPolicy): SlotDefinition {
  const businessDate = businessDateForInstant(intent.scheduledFor, policy.timeZone);
  for (const slot of policy.slots) {
    const target = instantForLocalDateTime(businessDate, slot.localTime, policy.timeZone);
    if (target === new Date(intent.scheduledFor).toISOString()) return slot;
  }
  throw new SchedulingPolicyError(
    `Intent ${intent.intentId} scheduledFor ${intent.scheduledFor} is not a canonical slot in ${policy.timeZone}`
  );
}

export function buildReservation(
  intent: PublicationIntent,
  policy: SchedulingPolicy,
  existingForAccountAndDate: readonly ScheduleReservation[],
  now: Instant
): ScheduleReservation {
  const businessDate = businessDateForInstant(intent.scheduledFor, policy.timeZone);
  const slot = matchingSlot(intent, policy);

  if (existingForAccountAndDate.length >= policy.maxPerAccountPerBusinessDate) {
    throw new SchedulingPolicyError(
      `Daily cap ${policy.maxPerAccountPerBusinessDate} reached for account ${intent.accountId} on ${businessDate}`
    );
  }

  if (existingForAccountAndDate.some((r) => r.slotKey === slot.key || r.targetAt === intent.scheduledFor)) {
    throw new SchedulingPolicyError(`Slot ${slot.key} already reserved for account ${intent.accountId} on ${businessDate}`);
  }

  for (const existing of existingForAccountAndDate) {
    if (minutesBetween(existing.targetAt, intent.scheduledFor) < policy.minimumSpacingMinutes) {
      throw new SchedulingPolicyError(
        `Minimum spacing ${policy.minimumSpacingMinutes} min violated for account ${intent.accountId}`
      );
    }
  }

  if (!policy.overflowAllowed && !policy.slots.some((candidate) => candidate.key === slot.key)) {
    throw new SchedulingPolicyError("Overflow scheduling is disabled");
  }

  return {
    reservationId: `reservation:${intent.intentId}`,
    intentId: intent.intentId,
    accountId: intent.accountId,
    platform: intent.platform,
    businessDate,
    slotKey: slot.key,
    targetAt: new Date(intent.scheduledFor).toISOString(),
    windowStartAt: addMinutes(intent.scheduledFor, -policy.windowMinutes),
    windowEndAt: addMinutes(intent.scheduledFor, policy.windowMinutes),
    createdAt: new Date(now).toISOString()
  };
}
