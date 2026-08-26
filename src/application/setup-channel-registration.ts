import type { Instant, UUID } from "../domain/model.js";
import type { Actor } from "../domain/control-plane.js";
import type { BrowserIdentity, SocialAccount, StoredBrowserIdentity, StoredSocialAccount } from "../domain/browser-identity.js";
import { normalizeSocialHandle } from "../domain/browser-identity.js";
import type { BrowserIdentityStorePort } from "../domain/browser-identity-ports.js";
import type { ChannelDiscoveryResult } from "../domain/channel-discovery.js";
import { deriveAccountId, deriveIdentityId, deriveProfileKey, selectDiscoveredChannel } from "../domain/channel-discovery.js";
import type { ChannelSourceBinding, StoredChannelSourceBinding } from "../domain/source-binding.js";
import type { ChannelSourceBindingStorePort } from "../domain/source-binding-ports.js";
import { validateBrowserIdentityRegistration } from "./browser-identity-service.js";

export interface RegisterFromDiscoveryParams {
  /** The full probe output, not a handle. A channel absent from it cannot be registered. */
  result: ChannelDiscoveryResult;
  channelKey: string;
  checkId: UUID;
  now: Instant;
  actor: Actor;
  creatorId?: string;
}

export interface RegisteredChannel {
  account: StoredSocialAccount;
  identity: StoredBrowserIdentity;
  accountId: string;
  identityId: string;
  observedHandle: string;
}

export interface BindChannelSourceParams {
  accountId: string;
  bindingId: string;
  folderId: string;
  folderPath: string;
  interpretSubstructure: boolean;
  now: Instant;
  actor: Actor;
}

/**
 * Registers a social account from what a live session reported about itself.
 *
 * There is deliberately no overload taking a handle: the caller must hand over the discovery
 * result, and the chosen key is resolved against it. That is what makes "the handle was observed,
 * not asserted" a property of the code rather than a habit of whoever fills in the form.
 */
export class SetupChannelRegistrationService {
  constructor(private readonly store: BrowserIdentityStorePort & ChannelSourceBindingStorePort) {}

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
      profileKey: deriveProfileKey(result.platform, channel.channelKey),
      expectedHandle,
      enabled: true
    };
    validateBrowserIdentityRegistration(identity, account.platform, account.expectedHandle);

    const storedAccount = this.store.registerSocialAccount(account, now, actor).record;
    const storedIdentity = this.store.registerBrowserIdentity(identity, now, actor).record;

    // The observation itself is durable evidence: the audit trail shows the handle was read back
    // from the session at registration time, and the identity guard has a baseline to drift from.
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

  bindSource(params: BindChannelSourceParams): StoredChannelSourceBinding {
    const binding: ChannelSourceBinding = {
      bindingId: params.bindingId,
      accountId: params.accountId,
      source: "google_drive",
      folderId: params.folderId,
      folderPath: params.folderPath,
      interpretSubstructure: params.interpretSubstructure,
      enabled: true
    };
    return this.store.bindChannelSource(binding, params.now, params.actor).record;
  }
}
