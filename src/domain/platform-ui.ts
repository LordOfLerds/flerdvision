import type { Instant, Platform, PublicationFormat, PublicationIntent, UUID } from "./model.js";

export type PlatformCapability =
  | "web_video_upload"
  | "caption"
  | "title"
  | "description"
  | "reel"
  | "trial_reel"
  | "tiktok_video"
  | "youtube_short"
  | "story"
  | "final_action_boundary";

export type PlatformCapabilityState = "AVAILABLE" | "UNAVAILABLE" | "UNKNOWN" | "BLOCKED";

export interface PlatformCapabilityProbe {
  probeId: UUID;
  accountId: string;
  identityId: string;
  platform: Platform;
  probedAt: Instant;
  capabilities: Readonly<Partial<Record<PlatformCapability, PlatformCapabilityState>>>;
  currentUrl?: string;
  note?: string;
}

export interface PublicationPayload {
  copyVersionId: string;
  caption?: string;
  title?: string;
  description?: string;
  hashtags?: readonly string[];
}

export interface LocalMediaArtifact {
  contentId: string;
  sourceRef: string;
  localPath: string;
  sha256: string;
  sizeBytes: number;
}

export interface UiLocator {
  kind: "css" | "text" | "role" | "label";
  value: string;
  exact?: boolean;
  role?: string;
}

export interface UiActionSpec {
  action: "click" | "fill" | "set_file" | "wait" | "assert_visible";
  locators: readonly UiLocator[];
  valueFrom?: "caption" | "title" | "description" | "hashtags" | "media";
  literalValue?: string;
  optional?: boolean;
  timeoutMs?: number;
  label: string;
}

export interface PlatformUiSpec {
  platform: Platform;
  bootstrapUrl: string;
  supportedFormats: readonly PublicationFormat[];
  requiredCapabilities: Readonly<Partial<Record<PublicationFormat, readonly PlatformCapability[]>>>;
  capabilityLocators: Readonly<Partial<Record<PlatformCapability, readonly UiLocator[]>>>;
  preUploadActions: readonly UiActionSpec[];
  uploadActions: readonly UiActionSpec[];
  fieldActions: readonly UiActionSpec[];
  formatActions: Readonly<Partial<Record<PublicationFormat, readonly UiActionSpec[]>>>;
  finalActionBoundary: readonly UiLocator[];
}

export interface PreparationActionJournalEntry {
  at: Instant;
  label: string;
  action: string;
  outcome: "ok" | "optional_missing" | "blocked";
  locator?: string;
  note?: string;
}

export interface PlatformPrepareResult {
  intentId: string;
  accountId: string;
  identityId: string;
  platform: Platform;
  format: PublicationFormat;
  mediaSha256: string;
  mediaSizeBytes: number;
  reachedFinalActionBoundary: boolean;
  artifactRefs: readonly string[];
  journal: readonly PreparationActionJournalEntry[];
  preparedAt: Instant;
}

export function requiredCapabilitiesForIntent(intent: PublicationIntent): readonly PlatformCapability[] {
  const base: PlatformCapability[] = ["web_video_upload", "final_action_boundary"];
  if (intent.platform === "instagram") {
    base.push(intent.format === "trial_reel" ? "trial_reel" : intent.format === "story" ? "story" : "reel");
    base.push("caption");
  } else if (intent.platform === "tiktok") {
    base.push("tiktok_video", "caption");
  } else if (intent.platform === "youtube") {
    base.push("youtube_short", "title");
  }
  return base;
}

/**
 * The exact text a caption-bearing surface receives: the rendered caption plus the configured
 * hashtags. Publishing and verification MUST derive the posted copy from this one function --
 * marker-free verification compares the caption read back from the post page against it, so a
 * second, slightly different composition would silently turn every verified post into
 * `PUBLISH_UNCERTAIN`.
 */
export function composePostedCaption(payload: PublicationPayload): string | undefined {
  if (payload.caption === undefined) return undefined;
  const tags = (payload.hashtags ?? []).map((tag) => `#${tag}`);
  return [payload.caption, ...tags].filter(Boolean).join(tags.length ? " " : "");
}

/**
 * Comparison form for post copy: whitespace collapsed (platforms re-wrap and re-indent what they
 * render), case preserved (case is content, and two posts differing only in case are two posts).
 */
export function collapsePostedText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
