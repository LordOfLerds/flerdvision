import type { Instant, UUID } from "../domain/model.js";
import type { Actor } from "../domain/control-plane.js";
import type { BrowserIdentity, SocialAccount, StoredBrowserIdentity, StoredSocialAccount } from "../domain/browser-identity.js";
import { normalizeSocialHandle } from "../domain/browser-identity.js";
import type { BrowserIdentityStorePort } from "../domain/browser-identity-ports.js";
import type { ChannelDiscoveryResult } from "../domain/channel-discovery.js";
import { deriveAccountId, deriveIdentityId, deriveProfileKey, selectDiscoveredChannel } from "../domain/channel-discovery.js";
import { validateBrowserIdentityRegistration } from "./browser-identity-service.js";

export interface RegisterFromDiscoveryParams {
  /** The full probe output, not a handle. A channel absent from it cannot be registered. */
  result: ChannelDiscoveryResult;
  channelKey: string;
  checkId: UUID;
  now: Instant;
  actor: Actor;
  creatorId?: string;
  /**
   * Profile to give this identity. Defaults to one derived from the channel key. The setup wizard
   * passes the seeded copy of the login profile so the session carries over without a second login.
   */
  profileKey?: string;
}

export interface RegisteredChannel {
  account: StoredSocialAccount;
  identity: StoredBrowserIdentity;
  accountId: string;
  identityId: string;
  observedHandle: string;
}

/**
 * Registers only the social account + isolated BrowserIdentity proven by live session discovery.
 *
 * Source routing is intentionally absent. Product onboarding creates SourceConnection/SourceLane
 * independently, and Programs later create canonical DistributionRoute records. Keeping channel
 * registration unable to write a folder/account binding makes the route-first architecture a code
 * property rather than a UI convention.
 */
export class SetupChannelRegistrationService {
  constructor(private readonly store: BrowserIdentityStorePort) {}

  registerFromDiscovery(params: RegisterFromDiscoveryParams): RegisteredChannel {
    const { result, channelKey, now, actor } = params;
    const channel = selectDiscoveredChannel(result, channelKey);

    const accountId = deriveAccountId(result.platform, channel.channelKey);
    const identityId = deriveIdentityId(result.platform, channel.channelKey);
    const expectedHandle = normalizeSocialHandle(channel.handle);

    const account: SocialAccount = {
      accountId,
      platform: result.platform,
      expectedHandle,
      enabled: true,
      ...(params.creatorId ? { creatorId: params.creatorId } : {})
    };
    const identity: BrowserIdentity = {
      identityId,
      accountId,
      platform: result.platform,
      profileKey: params.profileKey ?? deriveProfileKey(result.platform, channel.channelKey),
      expectedHandle,
      enabled: true
    };
    validateBrowserIdentityRegistration(identity, account.platform, account.expectedHandle);

    const storedAccount = this.store.registerSocialAccount(account, now, actor).record;
    const storedIdentity = this.store.registerBrowserIdentity(identity, now, actor).record;

    // Registration discovery is durable identity evidence. It proves which session/handle was read;
    // it does not imply any content source or DistributionRoute.
    this.store.recordSessionHealth(
      {
        checkId: params.checkId,
        identityId,
        checkedAt: result.discoveredAt,
        state: "HEALTHY",
        expectedHandle,
        observedHandle: expectedHandle,
        note: `Registered from channel discovery (${result.channels.length} channel(s) offered)`,
        ...(result.currentUrl ? { currentUrl: result.currentUrl } : {})
      },
      actor
    );

    return { account: storedAccount, identity: storedIdentity, accountId, identityId, observedHandle: expectedHandle };
  }
}
