import { collapsePostedText } from "../../domain/platform-ui.js";

/**
 * Marker-free post matching.
 *
 * Production posts carry no visible `[FV:...]` marker any more, so the verifier can no longer
 * find "its" post by reading a token off the page. It instead opens the account's own newest
 * posts and requires that the copy on the opened post page is *exactly* the copy the run posted,
 * on a post that was published inside the run's own publish window. Anything else -- several
 * equal captions, no readable caption, an unreadable or date-only timestamp -- is inconclusive,
 * never a guess and never "take the newest one".
 */
export interface ProfileCaptionMatchSpec {
  /**
   * CSS selectors for the caption/title on an opened post page, tried in order; the first one
   * that yields non-empty text wins. `content` attributes (meta tags) count as text.
   */
  captionSelectors: readonly string[];
  /**
   * CSS selector for the post's own publish timestamp. Required: without a readable publish time
   * the window cannot be applied, and a post outside the window must never be matched.
   */
  timestampSelector: string;
  /** Attribute holding the timestamp; the literal `text` reads the element's text instead. */
  timestampAttribute?: string;
  /** Optional media duration on the post page; a `video` element's own duration also counts. */
  durationSelector?: string;
  durationAttribute?: string;
  /** How far before the final action a post may have been published. Default 120 s. */
  windowLeadSeconds?: number;
}

export interface ObservedPost {
  url: string;
  caption: string;
  captionSelector: string;
  timestampRaw: string;
  durationRaw: string;
  durationProperty: number | null;
}

/**
 * One read of an opened post page. The sentinel in the first line is what session fakes match on;
 * it also makes the expression greppable in a captured DOM artifact.
 */
export function postReadExpression(match: ProfileCaptionMatchSpec): string {
  const captionSelectors = JSON.stringify(match.captionSelectors);
  const timestampSelector = JSON.stringify(match.timestampSelector);
  const timestampAttribute = JSON.stringify(match.timestampAttribute ?? "datetime");
  const durationSelector = JSON.stringify(match.durationSelector ?? "");
  const durationAttribute = JSON.stringify(match.durationAttribute ?? "");
  return `(() => {
    /* __FV_POST_READ__ */
    const normalize = (value) => String(value === null || value === undefined ? '' : value).replace(/\\s+/g, ' ').trim();
    const first = (selector) => { try { return document.querySelector(selector); } catch { return null; } };
    const textOf = (element) => {
      if (!element) return '';
      const attribute = element.getAttribute && element.getAttribute('content');
      return normalize(attribute || element.textContent || '');
    };
    let caption = '', captionSelector = '';
    for (const selector of ${captionSelectors}) {
      const value = textOf(first(selector));
      if (value) { caption = value; captionSelector = selector; break; }
    }
    let timestampRaw = '';
    const timeElement = first(${timestampSelector});
    if (timeElement) {
      timestampRaw = ${timestampAttribute} === 'text'
        ? normalize(timeElement.textContent)
        : normalize(timeElement.getAttribute(${timestampAttribute}) || '');
    }
    let durationRaw = '', durationProperty = null;
    if (${durationSelector}) {
      const mediaElement = first(${durationSelector});
      if (mediaElement) {
        if (typeof mediaElement.duration === 'number' && isFinite(mediaElement.duration) && mediaElement.duration > 0) durationProperty = mediaElement.duration;
        durationRaw = ${durationAttribute}
          ? normalize(mediaElement.getAttribute(${durationAttribute}) || '')
          : normalize(mediaElement.textContent || '');
      }
    }
    return { caption, captionSelector, timestampRaw, durationRaw, durationProperty };
  })()`;
}

/**
 * A publish time without a time of day cannot be placed in a two-minute window. Platforms that
 * only render a date ("3.9.2026") are therefore treated as unreadable rather than as midnight,
 * which would push a post that was just published out of its own window.
 */
export function parsePostTimestamp(raw: string): number | undefined {
  const value = raw.trim();
  if (!value) return undefined;
  if (!/\d{1,2}:\d{2}/.test(value)) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** `7`, `7.2`, `0:07`, `1:02:03` and ISO-8601 `PT1M7S` all mean seconds. */
export function parseDurationSeconds(raw: string, property: number | null): number | undefined {
  if (typeof property === "number" && Number.isFinite(property) && property > 0) return property;
  const value = raw.trim();
  if (!value) return undefined;
  const iso = /^P(?:T)?(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/i.exec(value);
  if (iso && (iso[1] ?? iso[2] ?? iso[3])) return Number(iso[1] ?? 0) * 3600 + Number(iso[2] ?? 0) * 60 + Number(iso[3] ?? 0);
  if (/^\d{1,2}(:\d{2}){1,2}$/.test(value)) {
    return value.split(":").map(Number).reduce((total, part) => total * 60 + part, 0);
  }
  const plain = Number(value.replace(",", "."));
  return Number.isFinite(plain) && plain > 0 ? plain : undefined;
}

export type CaptionMatchVerdict = "MATCHED" | "INCONCLUSIVE" | "ABSENT";

export interface CaptionMatchOutcome {
  verdict: CaptionMatchVerdict;
  post?: ObservedPost;
  /** Operator-facing German note that names exactly what was seen. */
  note: string;
}

export interface CaptionMatchInput {
  posts: readonly ObservedPost[];
  expected: string;
  windowStartMs: number;
  windowEndMs: number;
  expectedDurationSeconds?: number;
}

/** Duration is a tie-breaker only, and only when it is unambiguous. */
const DURATION_TOLERANCE_SECONDS = 1;

/**
 * Decides from what was actually read on the opened post pages. It never falls back to "the
 * newest post": either exactly one post in the window carries exactly the posted copy, or the
 * observation is inconclusive, or every opened post is provably older than the window.
 */
export function classifyCaptionMatch(input: CaptionMatchInput): CaptionMatchOutcome {
  const expected = collapsePostedText(input.expected);
  if (!expected) return { verdict: "INCONCLUSIVE", note: "Erwartete Caption ist leer; ohne Vergleichstext ist kein Post identifizierbar." };
  if (input.posts.length === 0) {
    return { verdict: "INCONCLUSIVE", note: "Keine Post-Links auf der Listenseite gefunden; leeres Konto und nicht gerendertes Grid sind nicht unterscheidbar." };
  }

  const read = input.posts.map((post) => ({
    post,
    publishedAtMs: parsePostTimestamp(post.timestampRaw),
    captionText: collapsePostedText(post.caption)
  }));
  const unreadableTime = read.filter((item) => item.publishedAtMs === undefined);
  const unreadableCaption = read.filter((item) => !item.captionText);
  const inWindow = read.filter((item) => item.publishedAtMs !== undefined && item.publishedAtMs >= input.windowStartMs && item.publishedAtMs <= input.windowEndMs);
  const matches = inWindow.filter((item) => item.captionText === expected);

  if (matches.length === 1) {
    return { verdict: "MATCHED", post: matches[0]!.post, note: `Genau ein Post im Zeitfenster mit exakt der geposteten Caption (${inWindow.length} Post(s) im Fenster geprüft).` };
  }

  if (matches.length > 1) {
    if (input.expectedDurationSeconds !== undefined) {
      const byDuration = matches.filter((item) => {
        const seconds = parseDurationSeconds(item.post.durationRaw, item.post.durationProperty);
        return seconds !== undefined && Math.abs(seconds - input.expectedDurationSeconds!) <= DURATION_TOLERANCE_SECONDS;
      });
      if (byDuration.length === 1) {
        return {
          verdict: "MATCHED",
          post: byDuration[0]!.post,
          note: `${matches.length} Posts im Zeitfenster mit identischer Caption; eindeutig über die Videolänge (±${DURATION_TOLERANCE_SECONDS}s zu ${input.expectedDurationSeconds!.toFixed(2)}s) unterschieden.`
        };
      }
    }
    return { verdict: "INCONCLUSIVE", note: `${matches.length} Posts im Zeitfenster mit identischer Caption; die Videolänge konnte sie nicht unterscheiden.` };
  }

  if (unreadableCaption.length === read.length) {
    return { verdict: "INCONCLUSIVE", note: `0/${read.length} geöffnete Posts lieferten einen lesbaren Caption-Text; der Caption-Selector greift auf dieser Oberfläche nicht.` };
  }
  if (unreadableCaption.length > 0 || unreadableTime.length > 0) {
    return {
      verdict: "INCONCLUSIVE",
      note: `${read.length} Posts geöffnet, davon ${unreadableCaption.length} ohne lesbare Caption und ${unreadableTime.length} ohne verwertbare Veröffentlichungszeit; Abwesenheit ist damit nicht belegbar.`
    };
  }
  if (inWindow.length > 0) {
    return { verdict: "INCONCLUSIVE", note: `${inWindow.length} Posts im Zeitfenster, keiner mit passender Caption.` };
  }
  return {
    verdict: "ABSENT",
    note: `Kein Post im Zeitfenster: alle ${read.length} geöffneten Posts sind nachweislich älter als ${new Date(input.windowStartMs).toISOString()}.`
  };
}
