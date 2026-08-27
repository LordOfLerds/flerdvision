import type { Platform, PublicationFormat } from "./model.js";
import { normalizeSocialHandle } from "./browser-identity.js";

export type WorkspaceFormat = Exclude<PublicationFormat, "unknown">;
export type WorkspaceActivationMode = "NEW_ONLY" | "IMPORT_BACKLOG";

export interface WorkspaceSourceSpec {
  kind: "google_drive" | "local_folder";
  /** Google Drive folder URL/id or an absolute/local path. */
  root: string;
  structure: "auto";
  activation: WorkspaceActivationMode;
  maxDepth: number;
}

export interface WorkspaceFormatSettings {
  commentsEnabled?: boolean;
  shareToFeed?: boolean;
  crosspostFacebook?: boolean;
  visibility?: "only_you" | "friends" | "followers" | "everyone" | "private" | "unlisted" | "public";
  duetEnabled?: boolean;
  stitchEnabled?: boolean;
}

export interface WorkspaceChannelFormatSpec {
  type: WorkspaceFormat;
  /** Canonical local posting times in workspace timezone. */
  times: readonly string[];
  sourceMatch: readonly string[];
  captionTemplate?: string;
  titleTemplate?: string;
  descriptionTemplate?: string;
  hashtags: readonly string[];
  requirement: "REQUIRED" | "OPTIONAL";
  verificationMarker: boolean;
  settings: WorkspaceFormatSettings;
}

export interface WorkspaceChannelSpec {
  key: string;
  name: string;
  platform: Platform;
  handle: string;
  formats: readonly WorkspaceChannelFormatSpec[];
}

export interface WorkspacePrivateTestSpec {
  enabled: boolean;
  accountPrivate: boolean;
  approvedFollowers: number;
  contactsSyncOff: boolean;
  crossPostingOff: boolean;
  autoCleanup: boolean;
}

export interface WorkspaceNotificationSpec {
  onSuccess: "none" | "each" | "daily_summary";
  onBlocked: "immediate" | "daily_summary";
  onUncertain: "immediate";
}

export interface WorkspaceSpecV1 {
  schemaVersion: 1;
  workspace: {
    id: string;
    name: string;
    ownerEmail: string;
    timezone: string;
    runtimeRoot: string;
  };
  source: WorkspaceSourceSpec;
  channels: readonly WorkspaceChannelSpec[];
  notifications: WorkspaceNotificationSpec;
  privateTest: WorkspacePrivateTestSpec;
}

export class WorkspaceSpecError extends Error {}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WorkspaceSpecError(`${path} must be an object`);
  return value as Record<string, unknown>;
}
function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) throw new WorkspaceSpecError(`${path} is required`);
  return value.trim();
}
function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, path);
}
function booleanValue(value: unknown, fallback: boolean, path: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new WorkspaceSpecError(`${path} must be boolean`);
  return value;
}
function integerValue(value: unknown, fallback: number, path: string, min: number, max: number): number {
  const candidate = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(candidate) || candidate < min || candidate > max) throw new WorkspaceSpecError(`${path} must be an integer from ${min} to ${max}`);
  return candidate;
}
function stringArray(value: unknown, path: string): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new WorkspaceSpecError(`${path} must be an array of non-empty strings`);
  }
  return [...new Set(value.map((item) => (item as string).trim()))];
}
function identifier(value: unknown, path: string): string {
  const raw = requiredString(value, path);
  const normalized = raw.toLocaleLowerCase("en-US").replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!normalized || normalized.length > 80) throw new WorkspaceSpecError(`${path} is not a safe identifier`);
  return normalized;
}
function localTime(value: string, path: string): string {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new WorkspaceSpecError(`${path} must use HH:mm`);
  return value;
}
function defaultTimes(perDay: number): readonly string[] {
  const presets: Readonly<Record<number, readonly string[]>> = {
    1: ["18:00"],
    2: ["12:00", "19:00"],
    3: ["10:00", "15:00", "20:00"],
    4: ["09:00", "12:00", "16:00", "20:00"]
  };
  if (presets[perDay]) return presets[perDay]!;
  const start = 9 * 60;
  const end = 21 * 60;
  const step = perDay === 1 ? 0 : Math.floor((end - start) / (perDay - 1));
  return Array.from({ length: perDay }, (_, index) => {
    const minutes = start + index * step;
    return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  });
}
function platform(value: unknown, path: string): Platform {
  if (value !== "instagram" && value !== "tiktok" && value !== "youtube") throw new WorkspaceSpecError(`${path} must be instagram, tiktok or youtube`);
  return value;
}
function format(value: unknown, platformValue: Platform, path: string): WorkspaceFormat {
  const allowed: Readonly<Record<Platform, readonly WorkspaceFormat[]>> = {
    instagram: ["reel", "trial_reel", "story"],
    tiktok: ["tiktok"],
    youtube: ["short"]
  };
  if (typeof value !== "string" || !allowed[platformValue].includes(value as WorkspaceFormat)) {
    throw new WorkspaceSpecError(`${path} is invalid for ${platformValue}`);
  }
  return value as WorkspaceFormat;
}
function settings(value: unknown, platformValue: Platform, path: string): WorkspaceFormatSettings {
  const item = value === undefined ? {} : record(value, path);
  const out: WorkspaceFormatSettings = {};
  for (const key of ["commentsEnabled", "shareToFeed", "crosspostFacebook", "duetEnabled", "stitchEnabled"] as const) {
    if (item[key] !== undefined) {
      if (typeof item[key] !== "boolean") throw new WorkspaceSpecError(`${path}.${key} must be boolean`);
      Object.assign(out, { [key]: item[key] });
    }
  }
  if (item.visibility !== undefined) {
    const allowed = platformValue === "youtube" ? ["private", "unlisted", "public"] : ["only_you", "friends", "followers", "everyone"];
    if (typeof item.visibility !== "string" || !allowed.includes(item.visibility)) throw new WorkspaceSpecError(`${path}.visibility is invalid for ${platformValue}`);
    Object.assign(out, { visibility: item.visibility });
  }
  return out;
}

function parseFormat(value: unknown, platformValue: Platform, path: string): WorkspaceChannelFormatSpec {
  const item = record(value, path);
  const type = format(item.type, platformValue, `${path}.type`);
  const explicitTimes = stringArray(item.times, `${path}.times`).map((time, index) => localTime(time, `${path}.times[${index}]`));
  const perDay = integerValue(item.frequencyPerDay, explicitTimes.length || 1, `${path}.frequencyPerDay`, 1, 12);
  const times = explicitTimes.length > 0 ? explicitTimes : defaultTimes(perDay);
  if (new Set(times).size !== times.length) throw new WorkspaceSpecError(`${path}.times contains duplicates`);
  const requirement = item.requirement === undefined ? "REQUIRED" : item.requirement;
  if (requirement !== "REQUIRED" && requirement !== "OPTIONAL") throw new WorkspaceSpecError(`${path}.requirement must be REQUIRED or OPTIONAL`);
  return {
    type,
    times,
    sourceMatch: stringArray(item.sourceMatch, `${path}.sourceMatch`),
    ...(optionalString(item.captionTemplate, `${path}.captionTemplate`) ? { captionTemplate: optionalString(item.captionTemplate, `${path}.captionTemplate`)! } : {}),
    ...(optionalString(item.titleTemplate, `${path}.titleTemplate`) ? { titleTemplate: optionalString(item.titleTemplate, `${path}.titleTemplate`)! } : {}),
    ...(optionalString(item.descriptionTemplate, `${path}.descriptionTemplate`) ? { descriptionTemplate: optionalString(item.descriptionTemplate, `${path}.descriptionTemplate`)! } : {}),
    hashtags: stringArray(item.hashtags, `${path}.hashtags`).map((tag) => tag.replace(/^#/, "")),
    requirement,
    verificationMarker: booleanValue(item.verificationMarker, false, `${path}.verificationMarker`),
    settings: settings(item.settings, platformValue, `${path}.settings`)
  };
}

function parseChannel(value: unknown, index: number): WorkspaceChannelSpec {
  const path = `channels[${index}]`;
  const item = record(value, path);
  const platformValue = platform(item.platform, `${path}.platform`);
  if (!Array.isArray(item.formats) || item.formats.length === 0) throw new WorkspaceSpecError(`${path}.formats must be a non-empty array`);
  const formats = item.formats.map((entry, formatIndex) => parseFormat(entry, platformValue, `${path}.formats[${formatIndex}]`));
  if (new Set(formats.map((entry) => entry.type)).size !== formats.length) throw new WorkspaceSpecError(`${path}.formats contains duplicate types`);
  const handle = normalizeSocialHandle(requiredString(item.handle ?? item.name, `${path}.handle`));
  return {
    key: identifier(item.key ?? `${platformValue}-${handle}`, `${path}.key`),
    name: requiredString(item.name ?? handle, `${path}.name`),
    platform: platformValue,
    handle,
    formats
  };
}

export function parseWorkspaceSpec(value: unknown): WorkspaceSpecV1 {
  const root = record(value, "spec");
  if (root.schemaVersion !== 1) throw new WorkspaceSpecError("spec.schemaVersion must be 1");
  const workspace = record(root.workspace, "workspace");
  const source = record(root.source, "source");
  const sourceKind = source.kind;
  if (sourceKind !== "google_drive" && sourceKind !== "local_folder") throw new WorkspaceSpecError("source.kind must be google_drive or local_folder");
  const activation = source.activation ?? "NEW_ONLY";
  if (activation !== "NEW_ONLY" && activation !== "IMPORT_BACKLOG") throw new WorkspaceSpecError("source.activation must be NEW_ONLY or IMPORT_BACKLOG");
  if (!Array.isArray(root.channels) || root.channels.length === 0) throw new WorkspaceSpecError("channels must be a non-empty array");
  const channels = root.channels.map(parseChannel);
  if (new Set(channels.map((channel) => channel.key)).size !== channels.length) throw new WorkspaceSpecError("channel keys must be unique");
  const notifications = root.notifications === undefined ? {} : record(root.notifications, "notifications");
  const onSuccess = notifications.onSuccess ?? "daily_summary";
  const onBlocked = notifications.onBlocked ?? "immediate";
  const onUncertain = notifications.onUncertain ?? "immediate";
  if (onSuccess !== "none" && onSuccess !== "each" && onSuccess !== "daily_summary") throw new WorkspaceSpecError("notifications.onSuccess is invalid");
  if (onBlocked !== "immediate" && onBlocked !== "daily_summary") throw new WorkspaceSpecError("notifications.onBlocked is invalid");
  if (onUncertain !== "immediate") throw new WorkspaceSpecError("notifications.onUncertain must be immediate");
  const privateTest = root.privateTest === undefined ? {} : record(root.privateTest, "privateTest");
  return {
    schemaVersion: 1,
    workspace: {
      id: identifier(workspace.id, "workspace.id"),
      name: requiredString(workspace.name, "workspace.name"),
      ownerEmail: optionalString(workspace.ownerEmail, "workspace.ownerEmail") ?? "info@flerdvision.com",
      timezone: optionalString(workspace.timezone, "workspace.timezone") ?? "Europe/Vienna",
      runtimeRoot: optionalString(workspace.runtimeRoot, "workspace.runtimeRoot") ?? "runtime"
    },
    source: {
      kind: sourceKind,
      root: requiredString(source.root, "source.root"),
      structure: "auto",
      activation,
      maxDepth: integerValue(source.maxDepth, 4, "source.maxDepth", 1, 8)
    },
    channels,
    notifications: { onSuccess, onBlocked, onUncertain },
    privateTest: {
      enabled: booleanValue(privateTest.enabled, false, "privateTest.enabled"),
      accountPrivate: booleanValue(privateTest.accountPrivate, false, "privateTest.accountPrivate"),
      approvedFollowers: integerValue(privateTest.approvedFollowers, 0, "privateTest.approvedFollowers", 0, 1_000_000_000),
      contactsSyncOff: booleanValue(privateTest.contactsSyncOff, false, "privateTest.contactsSyncOff"),
      crossPostingOff: booleanValue(privateTest.crossPostingOff, false, "privateTest.crossPostingOff"),
      autoCleanup: booleanValue(privateTest.autoCleanup, false, "privateTest.autoCleanup")
    }
  };
}
