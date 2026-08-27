import type { SocialAccount } from "./browser-identity.js";
import type { AuditEvent } from "./control-plane.js";
import type { ContentAsset, DailyPlan, DeliveryAggregate } from "./distribution.js";
import type { Incident } from "./operations.js";
import type { SourceActivationStatus } from "./source-activation-ports.js";
import type { SourcePollingRuntimeState } from "./source-poll-state-ports.js";
import type { RuntimeCycleReport } from "../application/runtime-supervisor.js";
import type { LegacySourceBindingAudit } from "../application/legacy-source-binding-audit.js";
import type { ChannelReadiness, RouteTestReadiness, SurfaceReadiness } from "../application/control-center-read-model.js";

/** Runtime facts are operational state/evidence, not management configuration. */
export interface ControlCenterRuntimeSnapshot {
  plan: DailyPlan;
  accounts: readonly SocialAccount[];
  channelReadiness: readonly ChannelReadiness[];
  surfaceReadiness?: readonly SurfaceReadiness[];
  routeTests: readonly RouteTestReadiness[];
  assets: readonly ContentAsset[];
  deliveryAggregates?: readonly DeliveryAggregate[];
  sourceActivation?: readonly SourceActivationStatus[];
  sourcePolling?:SourcePollingRuntimeState;
  legacySourceBindings?:LegacySourceBindingAudit;
  incidents?: readonly Incident[];
  auditEvents?: readonly AuditEvent[];
  runtimeCycles?: readonly RuntimeCycleReport[];
}

export interface ControlCenterRuntimePort {
  snapshot(businessDate: string): Promise<ControlCenterRuntimeSnapshot>;
}
