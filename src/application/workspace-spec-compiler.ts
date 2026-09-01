import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { BrowserIdentityStorePort } from "../domain/browser-identity-ports.js";
import type { Actor } from "../domain/control-plane.js";
import type { DistributionConfigurationStorePort, StoredDistributionConfiguration } from "../domain/distribution-ports.js";
import type {
  CopyProfile,
  DistributionRoute,
  PostingProfile,
  SourceActivationCursor,
  SourceConnection,
  SourceLane
} from "../domain/distribution.js";
import type { SchedulingPolicy } from "../domain/scheduling.js";
import type { WorkspaceChannelFormatSpec, WorkspaceChannelSpec, WorkspaceSpecV1 } from "../domain/workspace-spec.js";
import type { SourceTopology } from "./source-structure-discovery.js";
import { assertConfigurationReferentialIntegrity } from "./distribution-config.js";

function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function stable(prefix: string, value: string): string { return `${prefix}:${digest(value).slice(0, 24)}`; }
function slug(value: string): string {
  const normalized = value.toLocaleLowerCase("en-US").replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!normalized) throw new Error(`Cannot derive stable slug from ${value}`);
  return normalized;
}
function atomicJson(path: string, value: unknown): void {
  const temp = `${path}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temp, path);
}
function readObject(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}
function semanticEqual(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }

export function accountIdForChannel(channel: WorkspaceChannelSpec): string { return `account:${channel.platform}:${slug(channel.key)}`; }
export function identityIdForChannel(channel: WorkspaceChannelSpec): string { return `browser:${channel.platform}:${slug(channel.key)}`; }
export function profileKeyForChannel(channel: WorkspaceChannelSpec): string { return `${channel.platform}/${slug(channel.key)}`; }

/** Exported for tests: the pure per-format profile builder, free of store wiring. */
export function postingProfile(channel: WorkspaceChannelSpec, format: WorkspaceChannelFormatSpec): PostingProfile {
  const postingProfileId = stable("posting-profile", `${channel.key}|${format.type}|${JSON.stringify(format.settings)}`);
  const base = { postingProfileId, displayName: `${channel.name} · ${format.type}`, enabled: true };
  if (channel.platform === "instagram") {
    if (format.type !== "reel" && format.type !== "trial_reel" && format.type !== "story") throw new Error(`Invalid Instagram format ${format.type}`);
    return {
      ...base,
      platform: "instagram",
      format: format.type,
      commentsEnabled: format.settings.commentsEnabled ?? true,
      shareToFeed: format.settings.shareToFeed ?? format.type !== "story",
      crosspostFacebook: format.settings.crosspostFacebook ?? false,
      explicitSettings: Object.keys(format.settings ?? {}),
    };
  }
  if (channel.platform === "tiktok") {
    if (format.type !== "tiktok") throw new Error(`Invalid TikTok format ${format.type}`);
    const visibility = format.settings.visibility;
    if (visibility && visibility !== "only_you" && visibility !== "friends" && visibility !== "followers" && visibility !== "everyone") throw new Error(`Invalid TikTok visibility ${visibility}`);
    return {
      ...base,
      platform: "tiktok",
      format: "tiktok",
      visibility: visibility ?? "everyone",
      commentsEnabled: format.settings.commentsEnabled ?? true,
      duetEnabled: format.settings.duetEnabled ?? true,
      stitchEnabled: format.settings.stitchEnabled ?? true,
      explicitSettings: Object.keys(format.settings ?? {})
    };
  }
  if (format.type !== "short") throw new Error(`Invalid YouTube format ${format.type}`);
  const visibility = format.settings.visibility;
  if (visibility && visibility !== "private" && visibility !== "unlisted" && visibility !== "public") throw new Error(`Invalid YouTube visibility ${visibility}`);
  return { ...base, platform: "youtube", format: "short", visibility: visibility ?? "public", commentsEnabled: format.settings.commentsEnabled ?? true, ...(typeof format.settings.madeForKids === "boolean" ? { madeForKids: format.settings.madeForKids } : {}), explicitSettings: Object.keys(format.settings ?? {}) };
}

function payloadTemplate(channel: WorkspaceChannelSpec, format: WorkspaceChannelFormatSpec): { copy: CopyProfile; payload: Record<string, unknown> } {
  const marker = format.verificationMarker ? "\n\n[FV:{contentId}]" : "";
  const captionTemplate = format.captionTemplate ?? (channel.platform === "youtube" ? undefined : `{filename}${marker}`);
  const titleTemplate = format.titleTemplate ?? (channel.platform === "youtube" ? "{filename}" : undefined);
  const versionMaterial = JSON.stringify({ channel: channel.key, format: format.type, captionTemplate, titleTemplate, descriptionTemplate: format.descriptionTemplate, hashtags: format.hashtags });
  const versionId = `copy-v1:${digest(versionMaterial).slice(0, 20)}`;
  const copy: CopyProfile = {
    copyProfileId: stable("copy-profile", `${channel.key}|${format.type}`),
    displayName: `${channel.name} · ${format.type} copy`,
    versionId,
    strategy: "template",
    enabled: true
  };
  const payload: Record<string, unknown> = { copyVersionId: versionId };
  if (captionTemplate !== undefined) payload.captionTemplate = captionTemplate;
  if (titleTemplate !== undefined) payload.titleTemplate = titleTemplate;
  if (format.descriptionTemplate !== undefined) payload.descriptionTemplate = format.descriptionTemplate;
  if (format.hashtags.length > 0) payload.hashtags = [...format.hashtags];
  return { copy, payload };
}

function minuteOfDay(localTime: string): number {
  const [hours, minutes] = localTime.split(":").map(Number);
  return hours! * 60 + minutes!;
}

function schedulingPolicy(spec: WorkspaceSpecV1, channel: WorkspaceChannelSpec, format: WorkspaceChannelFormatSpec): { id: string; policy: SchedulingPolicy } {
  const slots = format.times.map((localTime, index) => ({ key: `${slug(channel.key)}-${slug(format.type)}-${index + 1}`, localTime }));
  // `maxPerAccountPerBusinessDate` and `minimumSpacingMinutes` are enforced by the planner across
  // ALL routes of one account, while `slots` stay per format. Deriving the two account-wide fields
  // from a single format made every additional format on the same channel exceed the channel's own
  // cap: a spec with reel 3x + story 2x produced five deliveries against an effective cap of two,
  // so the planner dropped the entire day as ACCOUNT_DAILY_CAP_CONFLICT and the backlog grew
  // forever without a single post. They must come from the channel's whole configured rhythm.
  const accountTimes = [...new Set(channel.formats.flatMap((item) => item.times))].sort((left, right) => minuteOfDay(left) - minuteOfDay(right));
  const accountPostsPerDay = channel.formats.reduce((total, item) => total + item.times.length, 0);
  // No artificial floor: a spacing above the operator's own configured gap can only ever reject
  // the rhythm the spec asked for, which is starvation, not safety.
  const minimumSpacingMinutes = accountTimes.length <= 1
    ? 0
    : Math.min(...accountTimes.slice(1).map((localTime, index) => minuteOfDay(localTime) - minuteOfDay(accountTimes[index]!)));
  const id = stable("schedule", `${spec.workspace.timezone}|${channel.key}|${format.type}|${format.times.join(",")}|${accountTimes.join(",")}|${accountPostsPerDay}`);
  return {
    id,
    policy: {
      timeZone: spec.workspace.timezone,
      slots,
      windowMinutes: 30,
      maxPerAccountPerBusinessDate: accountPostsPerDay,
      minimumSpacingMinutes,
      overflowAllowed: false,
      overflowMinimumSpacingMinutes: 240
    }
  };
}

function sourceProbeSelector(channel: WorkspaceChannelSpec): string {
  const handle = channel.handle.replace(/["\\]/g, "");
  if (channel.platform === "instagram") return `nav a[href="/${handle}/"], [role="navigation"] a[href="/${handle}/"], a[aria-label*="Profile"][href="/${handle}/"]`;
  if (channel.platform === "tiktok") return `nav a[href*="/@${handle}"], a[data-e2e*="profile"][href*="/@${handle}"]`;
  // Live-calibrated against the real own-channel page (2026-08-31): the handle renders as the
  // single yt-content-metadata-view-model span; Studio root carries no handle at all. Ownership
  // is proven separately by the owner-only Studio link (ownerProofSelector) -- the handle text
  // alone is visible to any visitor.
  return "yt-content-metadata-view-model span span";
}
function probeUrl(channel: WorkspaceChannelSpec): string {
  if (channel.platform === "youtube") return `https://www.youtube.com/@${channel.handle.replace(/["\\]/g, "")}`;
  return bootstrapUrl(channel);
}
function profileUrl(channel: WorkspaceChannelSpec): string {
  if (channel.platform === "instagram") return "https://www.instagram.com/{handle}/";
  if (channel.platform === "tiktok") return "https://www.tiktok.com/@{handle}";
  return "https://www.youtube.com/@{handle}/shorts";
}
function bootstrapUrl(channel: WorkspaceChannelSpec): string {
  if (channel.platform === "instagram") return "https://www.instagram.com/";
  if (channel.platform === "tiktok") return "https://www.tiktok.com/";
  return "https://studio.youtube.com/";
}
function preservedCalibratedEntry(path: string, collection: "probes" | "specs", accountId: string, platform: string, freshPayload?: unknown): Record<string, unknown> | undefined {
  const current = readObject(path)?.[collection];
  if (!Array.isArray(current)) return undefined;
  const entry = current.find((candidate) => {
    if (!candidate || typeof candidate !== "object") return false;
    const item = candidate as Record<string, unknown>;
    return item.accountId === accountId && item.platform === platform && item.calibrationStatus === "CALIBRATED";
  }) as Record<string, unknown> | undefined;
  if (!entry) return undefined;
  // Preserving calibration must not preserve an outdated contract: when the compiler template
  // for the payload changed (a live gap -- the reels-tab deep check never reached a calibrated
  // spec), the fresh template wins as UNVERIFIED and the next qualification recalibrates it.
  if (freshPayload !== undefined) {
    const payloadKey = collection === "specs" ? "spec" : "config";
    if (!semanticEqual(entry[payloadKey], freshPayload)) return undefined;
  }
  return entry;
}

function verificationSpecTemplate(channel: WorkspaceChannelSpec): Record<string, unknown> {
  return {
    platform: channel.platform,
    bootstrapUrl: bootstrapUrl(channel),
    profileUrlTemplate: profileUrl(channel),
    profileReadyLocators: [{ kind: "css", value: "main, [role=\"main\"]" }],
    postMatchLocators: [{ kind: "text", value: "{contentId}", exact: false }],
    permalinkAttribute: "href",
    // Instagram's profile grid renders no captions, and reels without share-to-feed only
    // exist under the reels tab: the marker is only readable on the opened post page.
    ...(channel.platform === "instagram" ? {
      postListUrlTemplate: `${profileUrl(channel)}reels/`,
      postLinkSelector: 'a[href*="/reel/"], a[href*="/p/"]',
      postOpenLimit: 3
    } : {})
  };
}

export interface WorkspaceCompileReport {
  workspaceId: string;
  revision: number;
  changed: boolean;
  sourceVerified: boolean;
  sources: number;
  lanes: number;
  accounts: number;
  routes: number;
  schedulePolicies: number;
  warnings: readonly string[];
}

export class WorkspaceSpecCompiler {
  constructor(
    private readonly configStore: DistributionConfigurationStorePort,
    private readonly browserStore: BrowserIdentityStorePort,
    private readonly configDir: string
  ) {}

  compile(spec: WorkspaceSpecV1, topology: SourceTopology, now: string, actor: Actor = { type: "operator", id: "headless-bootstrap" }): WorkspaceCompileReport {
    const timestamp = new Date(now).toISOString();
    const current = this.configStore.load();
    const rootRef = spec.source.kind === "google_drive" ? topology.rootId : resolve(spec.source.root);
    const source: SourceConnection = {
      connectionId: stable("source", `${spec.source.kind}|${rootRef}`),
      displayName: spec.source.kind === "google_drive" ? "Flerdvision Google Drive" : "Flerdvision local source",
      kind: spec.source.kind,
      rootRef,
      enabled: true,
      disposition: { mode: "database_only", leavePartialUntouched: true, leaveBlockedUntouched: true }
    };

    const streamByKey = new Map(topology.streams.map((stream) => [`${stream.channelKey}|${stream.format}`, stream]));
    const laneByRef = new Map<string, SourceLane>();
    const postingProfiles: PostingProfile[] = [];
    const copyProfiles: CopyProfile[] = [];
    const routes: DistributionRoute[] = [];
    const schedulePolicies: Record<string, SchedulingPolicy> = {};
    const payloads: Record<string, unknown>[] = [];

    for (const channel of spec.channels) {
      const accountId = accountIdForChannel(channel);
      this.browserStore.registerSocialAccount({ accountId, platform: channel.platform, expectedHandle: channel.handle, enabled: true }, timestamp, actor);
      this.browserStore.registerBrowserIdentity({
        identityId: identityIdForChannel(channel), accountId, platform: channel.platform, profileKey: profileKeyForChannel(channel), expectedHandle: channel.handle, enabled: true
      }, timestamp, actor);

      for (const format of channel.formats) {
        const stream = streamByKey.get(`${channel.key}|${format.type}`);
        if (!stream) throw new Error(`Source compiler did not select a stream for ${channel.key}/${format.type}`);
        let lane = laneByRef.get(stream.folderRef);
        if (!lane) {
          const laneId = stable("lane", `${source.connectionId}|${stream.folderRef}`);
          lane = {
            laneId,
            connectionId: source.connectionId,
            displayName: stream.folderPath.split(" / ").at(-1) ?? stream.folderPath,
            creatorId: stable("creator", `${spec.workspace.id}|${stream.folderRef}`),
            folderRef: stream.folderRef,
            folderPath: stream.folderPath,
            interpretation: { kind: "flat" },
            enabled: true
          };
          laneByRef.set(stream.folderRef, lane);
        }
        const profile = postingProfile(channel, format);
        const copyPayload = payloadTemplate(channel, format);
        const schedule = schedulingPolicy(spec, channel, format);
        postingProfiles.push(profile);
        copyProfiles.push(copyPayload.copy);
        payloads.push(copyPayload.payload);
        schedulePolicies[schedule.id] = schedule.policy;
        routes.push({
          routeId: stable("route", `${lane.laneId}|${accountId}|${profile.postingProfileId}`),
          displayName: `${lane.displayName} → ${channel.name} ${format.type}`,
          laneId: lane.laneId,
          accountId,
          platform: channel.platform,
          postingProfileId: profile.postingProfileId,
          copyProfileId: copyPayload.copy.copyProfileId,
          schedulePolicyId: schedule.id,
          requirement: format.requirement,
          enabled: true
        });
      }
    }

    const lanes = [...laneByRef.values()].sort((a, b) => a.laneId.localeCompare(b.laneId));
    const activationCursors: SourceActivationCursor[] = lanes.map((lane) => {
      const existing = current.config.activationCursors.find((cursor) => cursor.laneId === lane.laneId && cursor.mode === spec.source.activation);
      return existing ?? { laneId: lane.laneId, mode: spec.source.activation, activatedAt: timestamp };
    });
    postingProfiles.sort((a, b) => a.postingProfileId.localeCompare(b.postingProfileId));
    copyProfiles.sort((a, b) => a.copyProfileId.localeCompare(b.copyProfileId));
    routes.sort((a, b) => a.routeId.localeCompare(b.routeId));
    const config = { sources: [source], lanes, postingProfiles, copyProfiles, routes, activationCursors };
    assertConfigurationReferentialIntegrity(config);

    const next: Omit<StoredDistributionConfiguration, "revision"> = {
      updatedAt: timestamp,
      config,
      schedulePolicies,
      operatingCalendars: [],
      planningPolicy: { contentOrder: "FILENAME_NUMERIC_PREFIX", lateArrival: "NEXT_AVAILABLE_SLOT", overflow: "BACKLOG_NEXT_DAY" },
      ...(current.runtimePolicy ? { runtimePolicy: current.runtimePolicy } : {})
    };
    const comparableCurrent = { config: current.config, schedulePolicies: current.schedulePolicies, operatingCalendars: current.operatingCalendars ?? [], planningPolicy: current.planningPolicy, runtimePolicy: current.runtimePolicy };
    const comparableNext = { config: next.config, schedulePolicies: next.schedulePolicies, operatingCalendars: next.operatingCalendars ?? [], planningPolicy: next.planningPolicy, runtimePolicy: next.runtimePolicy };
    const changed = !semanticEqual(comparableCurrent, comparableNext);
    const stored = changed ? this.configStore.save(next, current.revision) : current;

    const payloadPath = resolve(this.configDir, "copy-payloads.json");
    atomicJson(payloadPath, { schemaVersion: 1, payloads });
    const probePath = resolve(this.configDir, "session-probes.json");
    const probes = spec.channels.map((channel) => {
      const accountId = accountIdForChannel(channel);
      const preserved = preservedCalibratedEntry(probePath, "probes", accountId, channel.platform);
      if (preserved) return preserved;
      return {
        probeId: `headless-${channel.key}`,
        platform: channel.platform,
        accountId,
        calibrationStatus: "UNVERIFIED",
        config: {
          probeUrl: probeUrl(channel),
          identitySelector: sourceProbeSelector(channel),
          ...(channel.platform === "youtube" ? {} : { identityAttribute: "href" }),
          ...(channel.platform === "youtube" ? { ownerProofSelector: 'a[href^="https://studio.youtube.com/channel/"]' } : {}),
          authUrlIncludes: channel.platform === "instagram" ? ["/accounts/login"] : channel.platform === "tiktok" ? ["/login"] : ["accounts.google.com"],
          challengeUrlIncludes: channel.platform === "instagram" ? ["/challenge/"] : channel.platform === "tiktok" ? ["/verify"] : [],
          settleMs: 1500,
          navigate: true
        }
      };
    });
    atomicJson(probePath, { schemaVersion: 1, probes });

    const verificationPath = resolve(this.configDir, "profile-verification.json");
    const specs = spec.channels.map((channel) => {
      const accountId = accountIdForChannel(channel);
      const freshSpec = verificationSpecTemplate(channel);
      const preserved = preservedCalibratedEntry(verificationPath, "specs", accountId, channel.platform, freshSpec);
      if (preserved) return preserved;
      return {
        specId: `headless-profile-${channel.key}`,
        platform: channel.platform,
        accountId,
        calibrationStatus: "UNVERIFIED",
        spec: freshSpec
      };
    });
    atomicJson(verificationPath, { schemaVersion: 1, specs });
    atomicJson(resolve(this.configDir, "workspace-spec.lock.json"), {
      schemaVersion: 1,
      compiledAt: timestamp,
      sourceVerified: topology.verified,
      sourceWarnings: topology.warnings,
      specDigest: digest(JSON.stringify(spec)),
      spec
    });

    return {
      workspaceId: spec.workspace.id,
      revision: stored.revision,
      changed,
      sourceVerified: topology.verified,
      sources: 1,
      lanes: lanes.length,
      accounts: spec.channels.length,
      routes: routes.length,
      schedulePolicies: Object.keys(schedulePolicies).length,
      warnings: topology.warnings
    };
  }
}
