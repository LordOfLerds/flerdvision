import { cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import type { Platform } from "../domain/model.js";
import { BrowserProfileDirectoryResolver } from "../adapters/browser/profile-lock.js";

/**
 * Setup has to open a browser before any account exists, because the whole point is to read the
 * channel out of the session rather than have it typed. But a browser identity owns its profile
 * exclusively -- profile_key is UNIQUE, and that isolation is not worth weakening.
 *
 * So the login happens in a profile that belongs to no identity, and each channel confirmed from
 * that session gets its own profile seeded from it. One login, one profile per identity, and a
 * Google account carrying three YouTube channels yields three independently lockable profiles.
 */

export function loginProfileKey(platform: Platform, slot: string = "primary"): string {
  const normalized = slot.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(normalized)) throw new Error(`Unsafe login slot: ${slot}`);
  return `${platform}/login-${normalized}`;
}

export function isLoginProfileKey(profileKey: string): boolean {
  return /\/login-[a-z0-9][a-z0-9_-]*$/.test(profileKey);
}

export interface SeedProfileParams {
  profilesRoot: string;
  fromProfileKey: string;
  toProfileKey: string;
  /** Replace an existing target instead of failing. Used when re-confirming the same channel. */
  overwrite?: boolean;
}

/**
 * Copies the login profile into the channel's own profile.
 *
 * The browser MUST be closed first: Chromium keeps lock files and an open leveldb, and copying a
 * live profile produces one that silently fails to restore the session.
 */
export function seedChannelProfile(params: SeedProfileParams): string {
  const resolver = new BrowserProfileDirectoryResolver(params.profilesRoot);
  const from = resolver.resolve(params.fromProfileKey);
  // resolve() creates the directory it hands back, so "it exists" says nothing about whether a
  // profile is already there. Emptiness is the honest test; anything else silently skips the copy
  // and leaves a channel with a profile that was never logged in.
  const to = resolver.resolve(params.toProfileKey);
  if (readdirSync(from).length === 0) {
    throw new Error(`Login profile is empty; log in before confirming a channel: ${params.fromProfileKey}`);
  }
  if (readdirSync(to).length > 0) {
    if (!params.overwrite) return to;
    rmSync(to, { recursive: true, force: true });
    mkdirSync(to, { recursive: true, mode: 0o700 });
  }
  cpSync(from, to, { recursive: true });
  return to;
}
