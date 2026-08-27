import type { SocialAccount } from "./browser-identity.js";
import type { ContentAsset, DailyPlan } from "./distribution.js";
import type { ChannelReadiness, RouteTestReadiness, SurfaceReadiness } from "../application/control-center-read-model.js";

/** Runtime facts are operational state, not management configuration. */
export interface ControlCenterRuntimeSnapshot {
  plan: DailyPlan;
  accounts: readonly SocialAccount[];
  channelReadiness: readonly ChannelReadiness[];
  surfaceReadiness?: readonly SurfaceReadiness[];
  routeTests: readonly RouteTestReadiness[];
  assets: readonly ContentAsset[];
}

export interface ControlCenterRuntimePort {
  snapshot(businessDate: string): Promise<ControlCenterRuntimeSnapshot>;
}
