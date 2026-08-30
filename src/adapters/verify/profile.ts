import type { BrowserIdentityStorePort, BrowserProfileLockPort, BrowserRuntimePort, SessionProbePort } from "../../domain/browser-identity-ports.js";
import type { PublicationIntent, PublishAttempt, VerificationEvidence } from "../../domain/model.js";
import type { UiLocator } from "../../domain/platform-ui.js";
import type { VerificationArtifactSinkPort, VerificationEvidenceCollectorPort } from "../../domain/verification-ports.js";
import { AccountIdentityGuard, BrowserSessionHealthService } from "../../application/browser-identity-service.js";
import { BrowserDomUiDriver, UiTargetNotFoundError } from "../browser/dom-ui-driver.js";

export interface ProfileVerificationSpec {
  platform: PublicationIntent["platform"];
  bootstrapUrl: string;
  profileUrlTemplate: string;
  profileReadyLocators: readonly UiLocator[];
  postMatchLocators: readonly UiLocator[];
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
}

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
      const match = templateLocators(this.spec.postMatchLocators, intent, identity.expectedHandle);
      try {
        await driver.locate(ready, this.options.profileReadyTimeoutMs ?? 10_000, true);
      } catch (error) {
        if (error instanceof UiTargetNotFoundError) throw new Error("Profile verification surface did not reach a known-ready state");
        throw error;
      }

      const observedAt = this.now();
      const artifactRefs = await this.artifacts.capture(session, intent, identity, attempt, "profile-verification", observedAt);
      const artifactRef = artifactRefs[0];
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
        const selectorJson = JSON.stringify(this.spec.postLinkSelector);
        const limit = Math.max(1, Math.min(this.spec.postOpenLimit ?? 3, 10));
        const hrefs = await session.evaluate<readonly string[]>(
          `(() => Array.from(document.querySelectorAll(${selectorJson})).map((a) => a.getAttribute("href")).filter(Boolean).slice(0, ${limit}))()`
        ).catch(() => [] as const);
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
}
