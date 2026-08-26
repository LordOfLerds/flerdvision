import type { Instant, Platform } from "../../domain/model.js";
import type { BrowserPageSessionPort } from "../../domain/browser-identity-ports.js";
import type { ChannelDiscoveryPort } from "../../domain/channel-discovery-ports.js";
import type { ChannelDiscoveryResult, DiscoveredChannel } from "../../domain/channel-discovery.js";
import { ChannelDiscoveryError, UncalibratedChannelDiscoveryError, assertChannelKey } from "../../domain/channel-discovery.js";

export type ChannelDiscoveryCalibrationStatus = "UNVERIFIED" | "CALIBRATED";

export const CALIBRATION_PLACEHOLDER = "__CALIBRATE__";

export interface ChannelDiscoverySpec {
  platform: Platform;
  probeUrl: string;
  /** Repeated element, one per selectable channel. A single-account platform yields exactly one. */
  channelItemSelector: string;
  /** Attribute on the item carrying the platform's own stable key. */
  channelKeyAttribute: string;
  handleSelector: string;
  displayNameSelector?: string;
  detailSelector?: string;
  authUrlIncludes?: readonly string[];
  challengeUrlIncludes?: readonly string[];
  authSelector?: string;
  challengeSelector?: string;
  settleMs?: number;
  navigate?: boolean;
}

export interface ChannelDiscoverySpecEntry {
  specId: string;
  platform: Platform;
  calibrationStatus: ChannelDiscoveryCalibrationStatus;
  calibratedAt?: string;
  calibratedBy?: string;
  spec: ChannelDiscoverySpec;
}

function stringLiteral(value: string): string {
  return JSON.stringify(value);
}

function assertCalibrated(entry: ChannelDiscoverySpecEntry): void {
  if (entry.calibrationStatus !== "CALIBRATED") {
    throw new UncalibratedChannelDiscoveryError(
      `Channel discovery spec ${entry.specId} is ${entry.calibrationStatus}. Calibrate it against the real surface before using it.`
    );
  }
  const selectors = [
    entry.spec.channelItemSelector,
    entry.spec.channelKeyAttribute,
    entry.spec.handleSelector,
    entry.spec.displayNameSelector,
    entry.spec.detailSelector,
    entry.spec.authSelector,
    entry.spec.challengeSelector
  ];
  for (const selector of selectors) {
    if (typeof selector === "string" && selector.includes(CALIBRATION_PLACEHOLDER)) {
      throw new UncalibratedChannelDiscoveryError(
        `Channel discovery spec ${entry.specId} still contains a calibration placeholder`
      );
    }
  }
}

/**
 * Reads the channels an authenticated session can post to.
 *
 * Selectors are configuration, never source: they are calibrated against the real surface and
 * carry a calibration status, exactly like the publish specs. An uncalibrated spec refuses to run
 * rather than guessing at a markup shape nobody has verified.
 */
export class ConfiguredChannelDiscovery implements ChannelDiscoveryPort {
  private readonly byPlatform: Map<string, ChannelDiscoverySpecEntry>;

  constructor(entries: readonly ChannelDiscoverySpecEntry[]) {
    this.byPlatform = new Map(entries.map((entry) => [entry.platform, entry]));
  }

  async discover(session: BrowserPageSessionPort, platform: Platform, now: Instant): Promise<ChannelDiscoveryResult> {
    const entry = this.byPlatform.get(platform);
    if (!entry) throw new ChannelDiscoveryError(`No channel discovery spec for platform ${platform}`);
    assertCalibrated(entry);
    const spec = entry.spec;

    try {
      if (spec.navigate ?? true) await session.navigate(spec.probeUrl);
      if ((spec.settleMs ?? 0) > 0) {
        await session.evaluate(`new Promise(resolve => setTimeout(resolve, ${Math.trunc(spec.settleMs ?? 0)}))`);
      }

      const currentUrl = await session.currentUrl();
      const normalized = currentUrl.toLocaleLowerCase("en-US");

      if ((spec.challengeUrlIncludes ?? []).some((part) => normalized.includes(part.toLocaleLowerCase("en-US")))) {
        return { platform, state: "CHALLENGE", discoveredAt: now, channels: [], currentUrl, note: "Challenge URL detected" };
      }
      if ((spec.authUrlIncludes ?? []).some((part) => normalized.includes(part.toLocaleLowerCase("en-US")))) {
        return { platform, state: "AUTH_REQUIRED", discoveredAt: now, channels: [], currentUrl, note: "Authentication URL detected" };
      }
      if (spec.challengeSelector) {
        const found = await session.evaluate<boolean>(`Boolean(document.querySelector(${stringLiteral(spec.challengeSelector)}))`);
        if (found) return { platform, state: "CHALLENGE", discoveredAt: now, channels: [], currentUrl, note: "Challenge marker detected" };
      }
      if (spec.authSelector) {
        const found = await session.evaluate<boolean>(`Boolean(document.querySelector(${stringLiteral(spec.authSelector)}))`);
        if (found) return { platform, state: "AUTH_REQUIRED", discoveredAt: now, channels: [], currentUrl, note: "Authentication marker detected" };
      }

      const expression = `(() => {
        const items = Array.from(document.querySelectorAll(${stringLiteral(spec.channelItemSelector)}));
        const text = (root, selector) => {
          if (!selector) return null;
          const el = root.querySelector(selector);
          return el ? (el.textContent || "").trim() : null;
        };
        return items.map(item => ({
          channelKey: item.getAttribute(${stringLiteral(spec.channelKeyAttribute)}),
          handle: text(item, ${stringLiteral(spec.handleSelector)}),
          displayName: text(item, ${spec.displayNameSelector ? stringLiteral(spec.displayNameSelector) : "null"}),
          detail: text(item, ${spec.detailSelector ? stringLiteral(spec.detailSelector) : "null"})
        }));
      })()`;

      const raw = await session.evaluate<readonly {
        channelKey: string | null;
        handle: string | null;
        displayName: string | null;
        detail: string | null;
      }[]>(expression);

      if (!raw || raw.length === 0) {
        return {
          platform,
          state: "UNKNOWN",
          discoveredAt: now,
          channels: [],
          currentUrl,
          note: `No channel item matched ${spec.channelItemSelector}`
        };
      }

      const channels: DiscoveredChannel[] = [];
      for (const item of raw) {
        // A partially readable channel is a calibration problem, not a channel to offer.
        if (!item.channelKey || !item.handle) {
          return {
            platform,
            state: "UNKNOWN",
            discoveredAt: now,
            channels: [],
            currentUrl,
            note: "A channel item was missing its key or handle; the spec needs recalibration"
          };
        }
        const channel: DiscoveredChannel = {
          channelKey: assertChannelKey(item.channelKey),
          handle: item.handle.trim(),
          displayName: (item.displayName ?? item.handle).trim()
        };
        channels.push(item.detail ? { ...channel, detail: item.detail.trim() } : channel);
      }

      return { platform, state: "HEALTHY", discoveredAt: now, channels, currentUrl };
    } catch (error) {
      if (error instanceof ChannelDiscoveryError) throw error;
      return {
        platform,
        state: "UNREACHABLE",
        discoveredAt: now,
        channels: [],
        note: error instanceof Error ? error.message : String(error)
      };
    }
  }
}
