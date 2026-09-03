import type { BrowserIdentityStorePort, BrowserPageSessionPort, BrowserProfileLockPort, BrowserRuntimePort, SessionProbePort } from "../../domain/browser-identity-ports.js";
import type { BrowserIdentity } from "../../domain/browser-identity.js";
import type { PublicationIntent, PublishAttempt, VerificationEvidence } from "../../domain/model.js";
import type { UiLocator } from "../../domain/platform-ui.js";
import type { ExpectedPublicationCopyPort, VerificationArtifactSinkPort, VerificationEvidenceCollectorPort } from "../../domain/verification-ports.js";
import { AccountIdentityGuard, BrowserSessionHealthService } from "../../application/browser-identity-service.js";
import { collapsePostedText } from "../../domain/platform-ui.js";
import { BrowserDomUiDriver, UiTargetNotFoundError } from "../browser/dom-ui-driver.js";
import { classifyCaptionMatch, postReadExpression, type ObservedPost, type ProfileCaptionMatchSpec } from "./caption-match.js";

export type { ProfileCaptionMatchSpec } from "./caption-match.js";

export interface ProfileVerificationSpec {
  platform: PublicationIntent["platform"];
  bootstrapUrl: string;
  profileUrlTemplate: string;
  profileReadyLocators: readonly UiLocator[];
  /**
   * Marker matching. Only routes that still set `verificationMarker: true` need it: the caption
   * then ends in `[FV:{contentId}]` and a text locator can find the post. Marker-free routes set
   * `captionMatch` instead and leave this empty.
   */
  postMatchLocators?: readonly UiLocator[];
  /**
   * Marker-free matching: open the account's own newest posts and require the copy on the opened
   * post page to be exactly the copy the run posted, published inside the run's own window.
   */
  captionMatch?: ProfileCaptionMatchSpec;
  permalinkAttribute?: string;
  /**
   * Optional deep verification for surfaces whose profile page never renders captions:
   * Instagram's grid shows thumbnails only, and a reel without share-to-feed lives solely
   * under the reels tab -- a text match on the profile page is structurally blind there.
   * When set, the collector opens the list page, takes the newest links matching
   * postLinkSelector, opens each (up to postOpenLimit) and matches the marker on the post
   * page itself, where the caption text actually renders.
   */
  postListUrlTemplate?: string;
  postLinkSelector?: string;
  postOpenLimit?: number;
}

export interface DeclarativeProfileVerificationCollectorOptions {
  ownerId: string;
  headless?: boolean;
  profileReadyTimeoutMs?: number;
  matchTimeoutMs?: number;
  now?: () => string;
  /**
   * Required for `captionMatch` specs: the copy the run actually posted. Without it the collector
   * still reads the newest posts -- and reports whether their captions are readable at all --
   * but it can never declare a match.
   */
  expectedCopy?: ExpectedPublicationCopyPort;
}

/** Default: a post published up to two minutes before the final action still belongs to this run. */
const DEFAULT_WINDOW_LEAD_SECONDS = 120;
/**
 * Upper window tolerance. The platform stamps the post with its own clock; a post that reads a
 * few seconds "in the future" against ours is still this run's post, and excluding it would turn
 * a good publication into PUBLISH_UNCERTAIN.
 */
const CLOCK_SKEW_MS = 60_000;

function evidenceId(prefix: string, intentId: string, attemptId: string, now: string): string {
  return `${prefix}:${intentId}:${attemptId}:${new Date(now).getTime().toString(36)}:${Math.random().toString(36).slice(2, 9)}`;
}

function template(value: string, intent: PublicationIntent, expectedHandle: string): string {
  return value
    .replaceAll("{intentId}", intent.intentId)
    .replaceAll("{contentId}", intent.contentId)
    .replaceAll("{accountId}", intent.accountId)
    .replaceAll("{handle}", expectedHandle.replace(/^@/, ""));
}

function templateLocators(locators: readonly UiLocator[], intent: PublicationIntent, expectedHandle: string): UiLocator[] {
  return locators.map((locator) => ({ ...locator, value: template(locator.value, intent, expectedHandle) }));
}

export class DeclarativeProfileVerificationCollector implements VerificationEvidenceCollectorPort {
  readonly name: string;
  private readonly now: () => string;

  constructor(
    private readonly store: BrowserIdentityStorePort,
    private readonly browserRuntime: BrowserRuntimePort,
    private readonly profileLocks: BrowserProfileLockPort,
    private readonly sessionProbe: SessionProbePort,
    private readonly artifacts: VerificationArtifactSinkPort,
    private readonly spec: ProfileVerificationSpec,
    private readonly options: DeclarativeProfileVerificationCollectorOptions
  ) {
    this.name = `${spec.platform}_profile_verification`;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async collect(intent: PublicationIntent, attempt: PublishAttempt): Promise<readonly VerificationEvidence[]> {
    if (intent.platform !== this.spec.platform) return [];
    const account = this.store.getSocialAccount(intent.accountId);
    if (!account) throw new Error(`Unknown social account: ${intent.accountId}`);
    const identityRecord = this.store.listBrowserIdentities().find((record) => record.identity.accountId === intent.accountId);
    if (!identityRecord) throw new Error(`No browser identity for account ${intent.accountId}`);
    const identity = identityRecord.identity;
    if (identity.identityId !== attempt.browserIdentityId) throw new Error("Verification browser identity differs from publish attempt identity");

    const lock = this.profileLocks.acquire(identity, this.options.ownerId, this.now());
    let session: Awaited<ReturnType<BrowserRuntimePort["launch"]>> | undefined;
    try {
      session = await this.browserRuntime.launch(identity, { headless: this.options.headless ?? true, initialUrl: this.spec.bootstrapUrl });
      await new BrowserSessionHealthService(this.store, this.sessionProbe).check(
        identity.identityId,
        session,
        this.now(),
        { type: "worker", id: this.options.ownerId }
      );
      new AccountIdentityGuard(this.store).assertReady(identity.identityId);

      const profileUrl = template(this.spec.profileUrlTemplate, intent, identity.expectedHandle);
      await session.navigate(profileUrl);
      const driver = new BrowserDomUiDriver(session);
      const ready = templateLocators(this.spec.profileReadyLocators, intent, identity.expectedHandle);
      const match = templateLocators(this.spec.postMatchLocators ?? [], intent, identity.expectedHandle);
      try {
        await driver.locate(ready, this.options.profileReadyTimeoutMs ?? 10_000, true);
      } catch (error) {
        if (error instanceof UiTargetNotFoundError) throw new Error("Profile verification surface did not reach a known-ready state");
        throw error;
      }

      const observedAt = this.now();
      const artifactRefs = await this.artifacts.capture(session, intent, identity, attempt, "profile-verification", observedAt);
      const artifactRef = artifactRefs[0];

      if (this.spec.captionMatch) {
        return await this.collectByCaption(session, driver, intent, attempt, identity, ready, artifactRef);
      }
      if (match.length === 0) throw new Error("Profile verification spec configures neither postMatchLocators nor captionMatch");

      if (await driver.isPresent(match, this.options.matchTimeoutMs ?? 500, true)) {
        const href = await driver.attribute(match, this.spec.permalinkAttribute ?? "href", this.options.matchTimeoutMs ?? 500);
        return [{
          evidenceId: evidenceId(href ? "profile-link" : "profile-match", intent.intentId, attempt.attemptId, observedAt),
          intentId: intent.intentId,
          attemptId: attempt.attemptId,
          kind: href ? "profile_permalink" : "profile_media_match",
          observedAt,
          positive: true,
          ...(href ? { locator: href } : {}),
          ...(artifactRef ? { artifactRef } : {})
        }];
      }

      if (this.spec.postListUrlTemplate && this.spec.postLinkSelector) {
        const listUrl = template(this.spec.postListUrlTemplate, intent, identity.expectedHandle);
        await session.navigate(listUrl);
        await driver.locate(ready, this.options.profileReadyTimeoutMs ?? 10_000, true).catch(() => {});
        const hrefs = await this.harvestPostLinks(session, this.spec.postLinkSelector);
        const listArtifacts = await this.artifacts.capture(session, intent, identity, attempt, "profile-verification-list", this.now());
        for (const href of hrefs) {
          const postUrl = new URL(href, listUrl).toString();
          await session.navigate(postUrl);
          const postSeen = await driver.isPresent(match, this.options.matchTimeoutMs ?? 3_000, true);
          const postObservedAt = this.now();
          const postArtifacts = await this.artifacts.capture(session, intent, identity, attempt, "profile-verification-post", postObservedAt);
          if (postSeen) {
            return [{
              evidenceId: evidenceId("post-permalink", intent.intentId, attempt.attemptId, postObservedAt),
              intentId: intent.intentId,
              attemptId: attempt.attemptId,
              kind: "profile_permalink",
              observedAt: postObservedAt,
              positive: true,
              locator: postUrl,
              ...(postArtifacts[0] ? { artifactRef: postArtifacts[0] } : {})
            }];
          }
        }
        return [{
          evidenceId: evidenceId("profile-negative", intent.intentId, attempt.attemptId, this.now()),
          intentId: intent.intentId,
          attemptId: attempt.attemptId,
          kind: "negative_profile_check",
          observedAt: this.now(),
          positive: false,
          ...(listArtifacts[0] ? { artifactRef: listArtifacts[0] } : {}),
          note: `configured publication match was absent on the profile page and on ${hrefs.length} opened post page(s)`
        }];
      }

      return [{
        evidenceId: evidenceId("profile-negative", intent.intentId, attempt.attemptId, observedAt),
        intentId: intent.intentId,
        attemptId: attempt.attemptId,
        kind: "negative_profile_check",
        observedAt,
        positive: false,
        ...(artifactRef ? { artifactRef } : {}),
        note: "profile surface was ready but configured publication match was absent"
      }];
    } finally {
      if (session) await session.close().catch(() => {});
      lock.release();
    }
  }

  /**
   * The grid mounts lazily after the header renders (live capture: header with "1 Beitrag"
   * visible, zero anchors in the DOM at first read). Poll briefly and nudge the page so lazy
   * tiles mount; read-only, bounded. DOM order on every one of these surfaces is newest first.
   */
  private async harvestPostLinks(session: BrowserPageSessionPort, selector: string): Promise<readonly string[]> {
    const selectorJson = JSON.stringify(selector);
    const limit = Math.max(1, Math.min(this.spec.postOpenLimit ?? 3, 10));
    let hrefs: readonly string[] = [];
    const deadline = Date.now() + (this.options.profileReadyTimeoutMs ?? 10_000);
    for (;;) {
      hrefs = await session.evaluate<readonly string[]>(
        `(() => Array.from(document.querySelectorAll(${selectorJson})).map((a) => a.getAttribute("href")).filter(Boolean).slice(0, ${limit}))()`
      ).catch(() => [] as const);
      if (hrefs.length > 0 || Date.now() >= deadline) break;
      await session.evaluate(`window.scrollBy(0, 600); true`).catch(() => {});
      await new Promise((resolvePoll) => setTimeout(resolvePoll, 600));
    }
    return hrefs;
  }

  /** The copy the run posted, or the reason why it is not available. Never read off the page. */
  private async expectedCopyFor(intent: PublicationIntent, attempt: PublishAttempt): Promise<{ text?: string; reason: string; durationSeconds?: number }> {
    if (!this.options.expectedCopy) return { reason: "kein Copy-Resolver für die Verifikation verdrahtet" };
    let copy;
    try {
      copy = await this.options.expectedCopy.expected(intent, attempt);
    } catch (error) {
      return { reason: `Copy-Resolver schlug fehl: ${error instanceof Error ? error.message : String(error)}` };
    }
    const text = this.spec.platform === "youtube" ? copy.title : copy.caption;
    if (!text || !collapsePostedText(text)) {
      return { reason: this.spec.platform === "youtube" ? "die Route hat keinen Titel gepostet" : "die Route hat keine Caption gepostet" };
    }
    return { text, reason: "ok", ...(copy.mediaDurationSeconds !== undefined ? { durationSeconds: copy.mediaDurationSeconds } : {}) };
  }

  /**
   * Marker-free matching. Opens the account's own newest posts, reads copy/timestamp/duration off
   * each post page and hands the observation to `classifyCaptionMatch`, which either finds
   * exactly one post in the window carrying exactly the posted copy or refuses to decide.
   */
  private async collectByCaption(
    session: BrowserPageSessionPort,
    driver: BrowserDomUiDriver,
    intent: PublicationIntent,
    attempt: PublishAttempt,
    identity: BrowserIdentity,
    ready: readonly UiLocator[],
    profileArtifactRef: string | undefined
  ): Promise<readonly VerificationEvidence[]> {
    const captionMatch = this.spec.captionMatch!;
    if (!this.spec.postListUrlTemplate || !this.spec.postLinkSelector) {
      throw new Error("Marker-free verification requires postListUrlTemplate and postLinkSelector: captions render on the post page, not on the grid");
    }
    const boundaryAt = attempt.finalActionInvokedAt ?? attempt.irreversibleBoundaryEnteredAt ?? attempt.startedAt;
    const boundaryMs = new Date(boundaryAt).getTime();
    if (!Number.isFinite(boundaryMs)) throw new Error(`Publish attempt ${attempt.attemptId} has no usable final-action timestamp`);

    const listUrl = template(this.spec.postListUrlTemplate, intent, identity.expectedHandle);
    await session.navigate(listUrl);
    await driver.locate(ready, this.options.profileReadyTimeoutMs ?? 10_000, true).catch(() => {});
    const hrefs = await this.harvestPostLinks(session, this.spec.postLinkSelector);
    const listArtifacts = await this.artifacts.capture(session, intent, identity, attempt, "profile-verification-list", this.now());

    const expression = postReadExpression(captionMatch);
    const posts: ObservedPost[] = [];
    const artifactByUrl = new Map<string, string>();
    for (const href of hrefs) {
      const postUrl = new URL(href, listUrl).toString();
      await session.navigate(postUrl);
      // The caption mounts after the media on every one of these surfaces, so a single read right
      // after navigation reads an empty page. Bounded poll, read-only, no clicking.
      const deadline = Date.now() + (this.options.profileReadyTimeoutMs ?? 10_000);
      let read: Omit<ObservedPost, "url"> | null = null;
      for (;;) {
        read = await session.evaluate<Omit<ObservedPost, "url"> | null>(expression).catch(() => null);
        if ((read?.caption ?? "") !== "" || Date.now() >= deadline) break;
        await new Promise((resolvePoll) => setTimeout(resolvePoll, 400));
      }
      const postObservedAt = this.now();
      const postArtifacts = await this.artifacts.capture(session, intent, identity, attempt, "profile-verification-post", postObservedAt);
      if (postArtifacts[0]) artifactByUrl.set(postUrl, postArtifacts[0]);
      posts.push({
        url: postUrl,
        caption: read?.caption ?? "",
        captionSelector: read?.captionSelector ?? "",
        timestampRaw: read?.timestampRaw ?? "",
        durationRaw: read?.durationRaw ?? "",
        durationProperty: read?.durationProperty ?? null
      });
    }

    const observedAt = this.now();
    const fallbackRef = posts.length > 0 ? artifactByUrl.get(posts.at(-1)!.url) ?? listArtifacts[0] : listArtifacts[0] ?? profileArtifactRef;
    const inconclusive = (note: string, artifactRef = fallbackRef): readonly VerificationEvidence[] => [{
      evidenceId: evidenceId("profile-inconclusive", intent.intentId, attempt.attemptId, observedAt),
      intentId: intent.intentId,
      attemptId: attempt.attemptId,
      kind: "inconclusive_profile_check",
      observedAt,
      positive: false,
      ...(artifactRef ? { artifactRef } : {}),
      note
    }];

    const expected = await this.expectedCopyFor(intent, attempt);
    const readableCaptions = posts.filter((post) => collapsePostedText(post.caption) !== "").length;
    if (!expected.text) {
      return inconclusive(`Keine erwartete Caption verfügbar (${expected.reason}); ${readableCaptions}/${posts.length} geöffnete Posts lieferten einen lesbaren Caption-Text.`);
    }

    const windowStartMs = boundaryMs - (captionMatch.windowLeadSeconds ?? DEFAULT_WINDOW_LEAD_SECONDS) * 1000;
    const windowEndMs = new Date(observedAt).getTime() + CLOCK_SKEW_MS;
    const outcome = classifyCaptionMatch({
      posts,
      expected: expected.text,
      windowStartMs,
      windowEndMs,
      ...(expected.durationSeconds !== undefined ? { expectedDurationSeconds: expected.durationSeconds } : {})
    });

    if (outcome.verdict === "MATCHED" && outcome.post) {
      return [{
        evidenceId: evidenceId("post-permalink", intent.intentId, attempt.attemptId, observedAt),
        intentId: intent.intentId,
        attemptId: attempt.attemptId,
        kind: "profile_permalink",
        observedAt,
        positive: true,
        locator: outcome.post.url,
        ...(artifactByUrl.get(outcome.post.url) ? { artifactRef: artifactByUrl.get(outcome.post.url)! } : {}),
        note: outcome.note
      }];
    }
    if (outcome.verdict === "ABSENT") {
      return [{
        evidenceId: evidenceId("profile-negative", intent.intentId, attempt.attemptId, observedAt),
        intentId: intent.intentId,
        attemptId: attempt.attemptId,
        kind: "negative_profile_check",
        observedAt,
        positive: false,
        ...(fallbackRef ? { artifactRef: fallbackRef } : {}),
        note: outcome.note
      }];
    }
    return inconclusive(outcome.note);
  }
}
