import type { Instant, UUID } from "../domain/model.js";
import type { Actor } from "../domain/control-plane.js";
import type { BrowserIdentity, SocialAccount, StoredBrowserIdentity, StoredSocialAccount } from "../domain/browser-identity.js";
import { normalizeSocialHandle } from "../domain/browser-identity.js";
import type { BrowserIdentityStorePort } from "../domain/browser-identity-ports.js";
import type { ChannelDiscoveryResult } from "../domain/channel-discovery.js";
import { deriveAccountId, deriveIdentityId, deriveProfileKey, selectDiscoveredChannel } from "../domain/channel-discovery.js";
import { validateBrowserIdentityRegistration } from "./browser-identity-service.js";

export interface RegisterFromDiscoveryParams {
  result: ChannelDiscoveryResult;
  channelKey: string;
  checkId: UUID;
  now: Instant;
  actor: Actor;
  creatorId?: string;
  profileKey?: string;
}

export interface RegisteredChannel {
  account: StoredSocialAccount;
  identity: StoredBrowserIdentity;
  accountId: string;
  identityId: string;
  observedHandle: string;
}

/** Registers only account + isolated BrowserIdentity proven by live session discovery. */
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
    this.store.recordSessionHealth({
      checkId: params.checkId,
      identityId,
      checkedAt: result.discoveredAt,
      state: "HEALTHY",
      expectedHandle,
      observedHandle: expectedHandle,
      note: `Registered from channel discovery (${result.channels.length} channel(s) offered)`,
      ...(result.currentUrl ? { currentUrl: result.currentUrl } : {})
    }, actor);

    return { account: storedAccount, identity: storedIdentity, accountId, identityId, observedHandle: expectedHandle };
  }

  /**
   * Compatibility guard for the retired SelfServiceHttpServer. It intentionally has no typed
   * source-binding dependency and can never mutate legacy binding state.
   */
  bindSource(_legacyParams: unknown): never {
    throw new Error("LEGACY_SOURCE_BINDING_DISABLED: source/account routing moved to Product Control Center / Programs");
  }
}
