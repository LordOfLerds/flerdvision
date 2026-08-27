import type { Instant } from "./model.js";

export interface SourcePollingPolicy {
  timeZone: string;
  activeWindowStartLocal: string;
  activeWindowEndLocal: string;
  activeIntervalMinutes: number;
  idleIntervalMinutes: number;
  pollImmediatelyOnStartup: boolean;
}

export interface OperatorReadinessPolicy {
  timeZone: string;
  morningSummaryLocalTime: string;
  preSlotWarningMinutes: number;
  preSlotEscalationMinutes: number;
  completionSummaryLocalTime: string;
  quietOnNormalSuccess: boolean;
}

export interface VerifiedMediaCachePolicy {
  /** Keep immutable verified bytes this long after DeliveryAggregate/source disposition completes. */
  retentionHoursAfterComplete: number;
}

export interface DistributionRuntimePolicy {
  sourcePolling: SourcePollingPolicy;
  readiness: OperatorReadinessPolicy;
  mediaCache: VerifiedMediaCachePolicy;
}

export const DEFAULT_DISTRIBUTION_RUNTIME_POLICY: DistributionRuntimePolicy = {
  sourcePolling: {
    timeZone: "Europe/Vienna",
    activeWindowStartLocal: "06:00",
    activeWindowEndLocal: "19:00",
    activeIntervalMinutes: 5,
    idleIntervalMinutes: 30,
    pollImmediatelyOnStartup: true
  },
  readiness: {
    timeZone: "Europe/Vienna",
    morningSummaryLocalTime: "08:00",
    preSlotWarningMinutes: 45,
    preSlotEscalationMinutes: 15,
    completionSummaryLocalTime: "18:00",
    quietOnNormalSuccess: true
  },
  mediaCache: {
    retentionHoursAfterComplete: 24
  }
};

export type SourcePollTrigger = "STARTUP" | "INTERVAL" | "MANUAL" | "SOURCE_RECONNECTED" | "PRE_SLOT" | "CONFIG_CHANGED";

export interface SourcePollDecision {
  due: boolean;
  trigger: SourcePollTrigger;
  nextPollAt: Instant;
  intervalMinutes: number;
}

function localMinutes(instant: Instant, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date(instant));
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
  return hour * 60 + minute;
}

function parseLocalTime(value: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error(`Invalid local time: ${value}`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error(`Invalid local time: ${value}`);
  return hour * 60 + minute;
}

function inActiveWindow(instant: Instant, policy: SourcePollingPolicy): boolean {
  const now = localMinutes(instant, policy.timeZone);
  const start = parseLocalTime(policy.activeWindowStartLocal);
  const end = parseLocalTime(policy.activeWindowEndLocal);
  if (start <= end) return now >= start && now < end;
  return now >= start || now < end;
}

function plusMinutes(instant: Instant, minutes: number): Instant {
  const time = new Date(instant).getTime();
  if (!Number.isFinite(time)) throw new Error(`Invalid instant: ${instant}`);
  return new Date(time + minutes * 60_000).toISOString();
}

export function decideSourcePoll(input: {
  now: Instant;
  lastPollAt?: Instant;
  policy?: SourcePollingPolicy;
  force?: Exclude<SourcePollTrigger, "INTERVAL">;
}): SourcePollDecision {
  const policy = input.policy ?? DEFAULT_DISTRIBUTION_RUNTIME_POLICY.sourcePolling;
  const intervalMinutes = inActiveWindow(input.now, policy) ? policy.activeIntervalMinutes : policy.idleIntervalMinutes;
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1) throw new Error("Source polling interval must be at least one minute");
  if (input.force) return { due: true, trigger: input.force, nextPollAt: plusMinutes(input.now, intervalMinutes), intervalMinutes };
  if (!input.lastPollAt) {
    return {
      due: policy.pollImmediatelyOnStartup,
      trigger: "STARTUP",
      nextPollAt: plusMinutes(input.now, intervalMinutes),
      intervalMinutes
    };
  }
  const dueAt = plusMinutes(input.lastPollAt, intervalMinutes);
  return { due: new Date(input.now).getTime() >= new Date(dueAt).getTime(), trigger: "INTERVAL", nextPollAt: dueAt, intervalMinutes };
}
