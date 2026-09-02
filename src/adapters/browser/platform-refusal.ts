import type { BrowserPageSessionPort } from "../../domain/browser-identity-ports.js";

/**
 * Platform refusals: the surface is intact, the account is simply not allowed to post right now.
 *
 * Found the hard way on a fresh YouTube channel. Twenty-four qualification runs in, Studio
 * started answering every upload with "Tägliches Upload-Limit erreicht" and greyed the details
 * form; the automation kept reporting an occluded text field and kept retrying, because nothing
 * in the flow ever read the sentence the platform had put on the screen. A refusal is not UI
 * drift and must never be repaired by clicking harder: the run stops, the reason is named, and
 * the operator hears exactly which account is limited and what would lift it.
 */
export class PlatformRefusedError extends Error {
  constructor(public readonly marker: string, detail: string) {
    super(detail);
    this.name = "PlatformRefusedError";
  }
}

/**
 * Sentences that mean "the platform is refusing", in the languages our surfaces render.
 * Each entry is matched case-insensitively against the visible page text.
 */
export const PLATFORM_REFUSAL_MARKERS: readonly string[] = [
  // Upload quotas (YouTube limits unverified channels to a handful of uploads per day).
  "tägliches upload-limit erreicht",
  "daily upload limit reached",
  "you have reached your daily upload limit",
  "upload limit exceeded",
  // Rate limiting / temporary blocks.
  "aktion blockiert",
  "action blocked",
  "try again later",
  "versuche es später noch einmal",
  "zu viele versuche",
  "too many attempts",
  // Account-level stops. These are hard: never retried, always reported.
  "dein konto wurde gesperrt",
  "your account has been suspended",
  "account disabled",
  "konto deaktiviert",
  "wir haben deinen beitrag entfernt",
  "we removed your post"
];

/**
 * Reads the visible page text and returns the refusal sentence the platform is showing, or null.
 * Visible text only: Studio keeps a stack of hidden error templates in the DOM at all times, and
 * matching those would stop healthy runs.
 */
export async function detectPlatformRefusal(session: BrowserPageSessionPort): Promise<PlatformRefusedError | null> {
  const found = await session
    .evaluate<{ marker: string; sentence: string } | null>(
      `(() => {
        const markers = ${JSON.stringify(PLATFORM_REFUSAL_MARKERS)};
        const visible = (el) => {
          const style = getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };
        const seen = [];
        for (const el of Array.from(document.querySelectorAll('div,span,p,yt-formatted-string,h1,h2,h3'))) {
          if (el.children.length > 0 || !visible(el)) continue;
          const text = (el.textContent || '').replace(/\\s+/g, ' ').trim();
          if (text.length > 0 && text.length <= 200) seen.push(text);
        }
        for (const marker of markers) {
          const hit = seen.find((text) => text.toLocaleLowerCase('en-US').includes(marker));
          if (hit) return { marker, sentence: hit };
        }
        return null;
      })()`
    )
    .catch(() => null);
  if (!found) return null;
  return new PlatformRefusedError(
    found.marker,
    `Platform refused this account: "${found.sentence}". This is an account state, not UI drift — no retry will fix it.`
  );
}
