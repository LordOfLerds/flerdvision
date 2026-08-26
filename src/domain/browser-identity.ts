import type { Instant, Platform, UUID } from "./model.js";

export interface SocialAccount {
  accountId: string;
  creatorId?: string;
  platform: Platform;
  expectedHandle: string;
  enabled: boolean;
}

export interface BrowserIdentity {
  identityId: string;
  accountId: string;
  platform: Platform;
  profileKey: string;
  expectedHandle: string;
  enabled: boolean;
}

export type SessionHealthState =
  | "HEALTHY"
  | "AUTH_REQUIRED"
  | "CHALLENGE"
  | "IDENTITY_MISMATCH"
  | "UNREACHABLE"
  | "UNKNOWN";

export interface SessionHealthCheck {
  checkId: UUID;
  identityId: string;
  checkedAt: Instant;
  state: SessionHealthState;
  expectedHandle: string;
  observedHandle?: string;
  currentUrl?: string;
  note?: string;
}

export interface StoredSocialAccount {
  account: SocialAccount;
  createdAt: Instant;
  updatedAt: Instant;
}

export interface StoredBrowserIdentity {
  identity: BrowserIdentity;
  createdAt: Instant;
  updatedAt: Instant;
}

export interface SessionProbeResult {
  state: SessionHealthState;
  observedHandle?: string;
  currentUrl?: string;
  note?: string;
}

export function normalizeSocialHandle(handle: string): string {
  const value = handle.trim();
  if (!value) throw new Error("Social handle cannot be empty");

  let candidate = value;
  if (/^https?:\/\//i.test(value)) {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error(`Invalid social handle URL: ${handle}`);
    }
    const host = parsed.hostname.replace(/^www\./i, "").toLocaleLowerCase("en-US");
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (host === "instagram.com") candidate = parts[0] ?? "";
    else if (host === "tiktok.com" || host === "youtube.com") candidate = (parts[0] ?? "").replace(/^@/, "");
    else throw new Error(`Unsupported social handle URL host: ${host}`);
  }

  const normalized = candidate.replace(/^@/, "").replace(/[/?#].*$/, "").trim().toLocaleLowerCase("en-US");
  if (!normalized) throw new Error(`Invalid social handle: ${handle}`);
  return normalized;
}

export function assertIdentityMatches(expectedHandle: string, observedHandle?: string): boolean {
  if (!observedHandle) return false;
  return normalizeSocialHandle(expectedHandle) === normalizeSocialHandle(observedHandle);
}
