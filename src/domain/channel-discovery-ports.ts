import type { Instant, Platform } from "./model.js";
import type { BrowserPageSessionPort } from "./browser-identity-ports.js";
import type { ChannelDiscoveryResult } from "./channel-discovery.js";

export interface ChannelDiscoveryPort {
  discover(session: BrowserPageSessionPort, platform: Platform, now: Instant): Promise<ChannelDiscoveryResult>;
}
