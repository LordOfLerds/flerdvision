import { createHash } from "node:crypto";
import type { Actor, ScheduleReservation, StoredPublicationIntent } from "../domain/control-plane.js";
import type { PublicationIntentStorePort, ScheduleStorePort } from "../domain/control-plane-ports.js";
import type { DistributionConfigurationStorePort } from "../domain/distribution-ports.js";
import type { DistributionProvenanceStorePort } from "../domain/distribution-provenance-ports.js";
import type { DistributionRuntimeStateStorePort } from "../domain/distribution-runtime-ports.js";
import type { ContentAsset, DailyPlan, PlannedDelivery } from "../domain/distribution.js";
import type { Platform } from "../domain/model.js";
import type { WorkspaceSpecV1 } from "../domain/workspace-spec.js";
import { businessDateForInstant } from "../domain/scheduling.js";
import { captureDailyPlanProvenance } from "./distribution-plan-provenance.js";
import { publicationIntentForDelivery } from "./distribution-planner.js";
import { accountIdForChannel } from "./workspace-spec-compiler.js";

export type FlerdvisionRuntimeRole = "acceptance" | "production";

export interface TestNowMaterializerPort {
  ensureIntents(plan: DailyPlan, now: string): Promise<{ created: number; existing: number; blocked: number; blockedReasons?: readonly string[] }>;
}

export interface TestNowExecutionPort {
  runIntent(intentId: string, now: string): Promise<unknown>;
}

export interface TestNowResult {
  customerName: string;
  channelName: string;
  platform: Platform;
  videoLabel: string;
  state: StoredPublicationIntent["state"];
  resumedExisting: boolean;
}

export interface AcceptanceTestNowDependencies {
  spec: WorkspaceSpecV1;
  role: FlerdvisionRuntimeRole;
  config: DistributionConfigurationStorePort;
  state: DistributionRuntimeStateStorePort;
  provenance: DistributionProvenanceStorePort;
  control: PublicationIntentStorePort & ScheduleStorePort;
  materializer: TestNowMaterializerPort;
  execution: TestNowExecutionPort;
  actor?: Actor;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function numericPrefix(name: string): number {
  const match = /^\s*(\d+)/.exec(name);
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
}

function sortAssets(assets: readonly ContentAsset[], policy: "FILENAME_NUMERIC_PREFIX" | "OBSERVED_AT" | "MANUAL_PRIORITY"): ContentAsset[] {
  return [...assets].sort((a, b) => {
    if (policy === "MANUAL_PRIORITY") {
      const ap = a.manualPriority ?? Number.POSITIVE_INFINITY;
      const bp = b.manualPriority ?? Number.POSITIVE_INFINITY;
      if (ap !== bp) return ap - bp;
    }
    if (policy === "FILENAME_NUMERIC_PREFIX") {
      const an = numericPrefix(a.filename), bn = numericPrefix(b.filename);
      if (an !== bn) return an - bn;
      const lexical = a.filename.localeCompare(b.filename, "de-AT", { numeric: true, sensitivity: "base" });
      if (lexical !== 0) return lexical;
    }
    const observed = a.observedAt.localeCompare(b.observedAt);
    if (observed !== 0) return observed;
    return a.assetId.localeCompare(b.assetId);
  });
}

function customerFor(spec: WorkspaceSpecV1, query: string) {
  const normalized = query.trim().toLocaleLowerCase("de-DE");
  const matches = spec.customers.filter((customer) =>
    customer.key.toLocaleLowerCase("de-DE") === normalized || customer.name.toLocaleLowerCase("de-DE") === normalized
  );
  if (matches.length !== 1) {
    const available = spec.customers.map((customer) => customer.name).join(", ");
    throw new Error(matches.length > 1 ? `Kunde „${query}“ ist mehrdeutig.` : `Unbekannter Kunde „${query}“. Verfügbar: ${available}`);
  }
  return matches[0]!;
}

function channelFor(spec: WorkspaceSpecV1, customerKey: string, platform: Platform) {
  const matches = spec.channels.filter((channel) => channel.customerKey === customerKey && channel.platform === platform);
  if (matches.length !== 1) {
    throw new Error(matches.length === 0
      ? `Für diesen Kunden ist kein ${platform}-Kanal konfiguriert.`
      : `Für diesen Kunden sind mehrere ${platform}-Kanäle konfiguriert; test-now verweigert eine geratenen Auswahl.`);
  }
  return matches[0]!;
}

function preferredFormat(platform: Platform): string {
  return platform === "instagram" ? "reel" : platform === "tiktok" ? "tiktok" : "short";
}

function semanticPlanId(plan: Omit<DailyPlan, "planId">): string {
  return `daily-plan:${plan.businessDate}:${digest(JSON.stringify({
    businessDate: plan.businessDate,
    deliveries: plan.deliveries,
    gaps: plan.gaps,
    backlog: plan.backlog,
    ...(plan.configFingerprint ? { configFingerprint: plan.configFingerprint } : {})
  }))}`;
}

function addMinutes(instant: string, minutes: number): string {
  return new Date(new Date(instant).getTime() + minutes * 60_000).toISOString();
}

function finalResult(record: StoredPublicationIntent, customerName: string, channelName: string, platform: Platform, videoLabel: string, resumedExisting: boolean): TestNowResult {
  return { customerName, channelName, platform, videoLabel, state: record.state, resumedExisting };
}

/**
 * Acceptance-only out-of-slot posting. It creates a normal PlannedDelivery + immutable plan
 * provenance + ordinary PublicationIntent/reservation, then delegates execution to the normal
 * authorized due worker supplied by the composition root. There is no test publisher here.
 */
export class AcceptanceTestNowService {
  private readonly actor: Actor;

  constructor(private readonly deps: AcceptanceTestNowDependencies) {
    this.actor = deps.actor ?? { type: "operator", id: "acceptance-test-now" };
  }

  async run(input: { customer: string; platform: Platform; now?: string }): Promise<TestNowResult> {
    if (this.deps.role !== "acceptance") throw new Error("test-now ist nur in einer Acceptance-Installation erlaubt.");
    const now = new Date(input.now ?? new Date().toISOString()).toISOString();
    const spec = this.deps.spec;
    const businessDate = businessDateForInstant(now, spec.workspace.timezone);
    const customer = customerFor(spec, input.customer);
    const channel = channelFor(spec, customer.key, input.platform);
    const accountId = accountIdForChannel(channel);
    const currentPlan = this.deps.state.latestDailyPlan(businessDate)?.plan;
    const testPrefix = `test-now:${customer.key}:${input.platform}:`;

    // Re-entering a command after a transport/CLI interruption resumes the same not-yet-terminal
    // one-shot instead of consuming a second video or creating a second publication attempt.
    for (const delivery of [...(currentPlan?.deliveries ?? [])].reverse()) {
      if (delivery.accountId !== accountId || !delivery.slotKey.startsWith(testPrefix)) continue;
      const envelope = this.deps.provenance.getIntentByDelivery(delivery.deliveryId);
      const record = envelope ? this.deps.control.getIntent(envelope.envelope.intent.intentId) : null;
      if (!record) continue;
      if (record.state === "SCHEDULED") {
        await this.deps.execution.runIntent(record.intent.intentId, now);
        const after = this.deps.control.getIntent(record.intent.intentId) ?? record;
        return finalResult(after, customer.name, channel.name, input.platform, this.deps.state.getAsset(delivery.assetId)?.asset.filename ?? "Video", true);
      }
      if (record.state === "PREPARING" || record.state === "PUBLISHING" || record.state === "VERIFYING") {
        throw new Error(`Ein test-now für ${customer.name} · ${channel.name} läuft bereits.`);
      }
      if (record.state === "PUBLISH_UNCERTAIN") {
        throw new Error(`Der letzte test-now für ${customer.name} · ${channel.name} ist PUBLISH_UNCERTAIN und muss zuerst verifiziert werden.`);
      }
    }

    const stored = this.deps.config.load();
    const expectedFormat = preferredFormat(input.platform);
    const matchingRoutes = stored.config.routes.filter((route) => {
      if (!route.enabled || route.accountId !== accountId || route.platform !== input.platform) return false;
      const posting = stored.config.postingProfiles.find((item) => item.postingProfileId === route.postingProfileId);
      return posting?.enabled === true && posting.format === expectedFormat;
    });
    if (matchingRoutes.length !== 1) {
      throw new Error(`test-now braucht genau eine freigegebene ${expectedFormat}-Route für ${customer.name} · ${channel.name}; gefunden: ${matchingRoutes.length}.`);
    }
    const route = matchingRoutes[0]!;
    const posting = stored.config.postingProfiles.find((item) => item.postingProfileId === route.postingProfileId)!;
    const copy = stored.config.copyProfiles.find((item) => item.copyProfileId === route.copyProfileId);
    if (!copy?.enabled) throw new Error(`Copy-Profil der Route ${channel.name} ist nicht aktiv.`);
    const schedule = stored.schedulePolicies[route.schedulePolicyId];
    if (!schedule) throw new Error(`Zeitplan der Route ${channel.name} fehlt.`);

    const accountIntents = this.deps.control.listIntents().filter((item) => item.intent.accountId === accountId);
    if (accountIntents.some((item) => item.state === "PUBLISH_UNCERTAIN")) {
      throw new Error(`Für ${customer.name} · ${channel.name} existiert bereits ein PUBLISH_UNCERTAIN; test-now bleibt gesperrt.`);
    }
    if (accountIntents.some((item) => item.state === "PREPARING" || item.state === "PUBLISHING" || item.state === "VERIFYING")) {
      throw new Error(`Für ${customer.name} · ${channel.name} läuft bereits eine Veröffentlichung.`);
    }
    const guardMinutes = Math.max(5, schedule.minimumSpacingMinutes);
    const nowMs = new Date(now).getTime();
    const nearby = this.deps.control.listReservations(accountId, businessDate).find((reservation) => {
      const record = this.deps.control.getIntent(reservation.intentId);
      if (!record || (record.state !== "SCHEDULED" && record.state !== "READY")) return false;
      return Math.abs(new Date(reservation.targetAt).getTime() - nowMs) < guardMinutes * 60_000;
    });
    if (nearby) throw new Error(`Ein normaler Slot dieses Accounts liegt weniger als ${guardMinutes} Minuten entfernt; test-now wird nicht dazwischen geschoben.`);

    const usedContentIds = new Set(accountIntents.map((item) => item.intent.contentId));
    const usedAssetIds = new Set((currentPlan?.deliveries ?? []).filter((item) => item.accountId === accountId).map((item) => item.assetId));
    const assets = sortAssets(
      this.deps.state.listAssets().map((item) => item.asset).filter((asset) =>
        asset.laneId === route.laneId && asset.state === "READY" && !usedContentIds.has(asset.contentId) && !usedAssetIds.has(asset.assetId)
      ),
      stored.planningPolicy.contentOrder
    );
    const asset = assets[0];
    if (!asset) throw new Error(`Kein ungebundenes READY-Video für ${customer.name} · ${channel.name} verfügbar.`);

    const slotKey = `${testPrefix}${digest(`${route.routeId}|${asset.assetId}|${now}`)}`;
    const delivery: PlannedDelivery = {
      deliveryId: `delivery:${digest(`${route.routeId}|${asset.assetId}|${now}|test-now`)}`,
      routeId: route.routeId,
      assetId: asset.assetId,
      contentId: asset.contentId,
      creatorId: asset.creatorId,
      laneId: route.laneId,
      accountId: route.accountId,
      platform: route.platform,
      format: posting.format,
      postingProfileId: route.postingProfileId,
      copyProfileId: route.copyProfileId,
      copyVersionId: copy.versionId,
      schedulePolicyId: route.schedulePolicyId,
      requirement: route.requirement,
      businessDate,
      slotKey,
      scheduledFor: now,
      windowStartAt: addMinutes(now, -1),
      windowEndAt: addMinutes(now, 10)
    };

    const withoutId: Omit<DailyPlan, "planId"> = {
      businessDate,
      generatedAt: now,
      deliveries: [...(currentPlan?.deliveries ?? []), delivery],
      gaps: currentPlan?.gaps ?? [],
      backlog: (currentPlan?.backlog ?? []).filter((item) => !(item.routeId === route.routeId && item.assetId === asset.assetId)),
      ...(currentPlan?.configFingerprint ? { configFingerprint: currentPlan.configFingerprint } : {})
    };
    const plan: DailyPlan = { ...withoutId, planId: semanticPlanId(withoutId) };

    // The plan head is inert. Provenance is persisted before the materializer can create a
    // runnable intent; a crash can therefore never leave a publishable one-shot without evidence.
    this.deps.state.putDailyPlan(plan, now);
    this.deps.provenance.putPlan(captureDailyPlanProvenance(plan, stored, now), now);
    const oneShotPlan: DailyPlan = { ...plan, deliveries: [delivery], gaps: [], backlog: [] };
    const materialized = await this.deps.materializer.ensureIntents(oneShotPlan, now);
    const intent = publicationIntentForDelivery(delivery);
    const record = this.deps.control.getIntent(intent.intentId);
    if (!record || record.state !== "SCHEDULED") {
      const reason = materialized.blockedReasons?.join("; ") ?? `state=${record?.state ?? "missing"}`;
      throw new Error(`test-now konnte den normalen PublicationIntent nicht sicher reservieren: ${reason}`);
    }
    const reservation: ScheduleReservation | null = this.deps.control.getReservationForIntent(intent.intentId);
    if (!reservation || reservation.targetAt !== now) throw new Error("test-now PublicationIntent hat keine exakte One-Shot-Reservation.");

    await this.deps.execution.runIntent(intent.intentId, now);
    const after = this.deps.control.getIntent(intent.intentId) ?? record;
    return finalResult(after, customer.name, channel.name, input.platform, asset.filename, false);
  }
}
