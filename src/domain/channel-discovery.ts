import type { Instant, Platform } from "./model.js";
import type { SessionHealthState } from "./browser-identity.js";

/**
 * What an authenticated session reports about itself.
 *
 * Setup used to ask the operator to type an account id and an expected handle BEFORE logging in,
 * which left the identity guard comparing a person's memory against reality -- a typo detector.
 * Discovery inverts that: the session is read first, the operator picks from what was found, and
 * the guard is freed to do its real job, namely noticing when a session later drifts to a
 * different account.
 */

export interface DiscoveredChannel {
  /** Stable per-platform key, e.g. a YouTube channel id. Used to derive the internal account id. */
  channelKey: string;
  /** Handle as the platform renders it. Normalized before it reaches storage. */
  handle: string;
  displayName: string;
  /** Free-form context shown to the operator, e.g. "1.240 Abos". Never interpreted. */
  detail?: string;
}

export interface ChannelDiscoveryResult {
  platform: Platform;
  state: SessionHealthState;
  discoveredAt: Instant;
  channels: readonly DiscoveredChannel[];
  currentUrl?: string;
  note?: string;
}

export class ChannelDiscoveryError extends Error {}
export class UncalibratedChannelDiscoveryError extends ChannelDiscoveryError {}

export function assertChannelKey(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new ChannelDiscoveryError("Channel key cannot be empty");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(normalized)) {
    throw new ChannelDiscoveryError(`Unsafe channel key: ${value}`);
  }
  return normalized;
}

/**
 * The internal account id is derived, never invented by the operator. Two workspaces can hold the
 * same derived id for different real accounts -- isolation is the workspace's job, not the id's.
 */
export function deriveAccountId(platform: Platform, channelKey: string): string {
  return `${platform}_${assertChannelKey(channelKey).toLowerCase()}`;
}

export function deriveIdentityId(platform: Platform, channelKey: string): string {
  return `browser:${deriveAccountId(platform, channelKey)}`;
}

export function deriveProfileKey(platform: Platform, channelKey: string): string {
  return `${platform}/${assertChannelKey(channelKey).toLowerCase()}`;
}

/**
 * Resolves an operator's pick against what the probe actually returned.
 *
 * Taking the whole result rather than a bare handle is the point: a handle that was never in the
 * discovery output cannot be registered, so there is no path back to typing one in.
 */
export function selectDiscoveredChannel(
  result: ChannelDiscoveryResult,
  channelKey: string
): DiscoveredChannel {
  if (result.state !== "HEALTHY") {
    throw new ChannelDiscoveryError(
      `Session is not healthy (${result.state})${result.note ? `: ${result.note}` : ""}`
    );
  }
  if (result.channels.length === 0) {
    throw new ChannelDiscoveryError("Session reported no channels");
  }
  const chosen = result.channels.find((candidate) => candidate.channelKey === channelKey);
  if (!chosen) {
    throw new ChannelDiscoveryError(
      `Channel ${channelKey} was not part of the discovered session; discovered: ${result.channels.map((c) => c.channelKey).join(", ")}`
    );
  }
  return chosen;
}
