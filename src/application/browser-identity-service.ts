import type { Actor } from "../domain/control-plane.js";
import type { BrowserIdentityStorePort, BrowserPageSessionPort, SessionProbePort } from "../domain/browser-identity-ports.js";
import type { BrowserIdentity, SessionHealthCheck } from "../domain/browser-identity.js";
import { assertIdentityMatches, normalizeSocialHandle } from "../domain/browser-identity.js";

function checkId(identityId: string, checkedAt: string): string {
  return `health:${identityId}:${new Date(checkedAt).getTime().toString(36)}:${Math.random().toString(36).slice(2, 9)}`;
}

export class AccountIdentityMismatchError extends Error {}
export class SessionNotReadyError extends Error {}

export class BrowserSessionHealthService {
  constructor(
    private readonly store: BrowserIdentityStorePort,
    private readonly probe: SessionProbePort
  ) {}

  async check(identityId: string, session: BrowserPageSessionPort, now: string, actor: Actor): Promise<SessionHealthCheck> {
    const stored = this.store.getBrowserIdentity(identityId);
    if (!stored) throw new Error(`Unknown browser identity: ${identityId}`);
    const identity = stored.identity;
    const result = await this.probe.probe(session, identity);
    let state = result.state;
    let note = result.note;

    if (state === "HEALTHY") {
      if (!assertIdentityMatches(identity.expectedHandle, result.observedHandle)) {
        state = "IDENTITY_MISMATCH";
        note = `Expected @${normalizeSocialHandle(identity.expectedHandle)} but observed ${result.observedHandle ?? "no handle"}`;
      }
    }

    const check: SessionHealthCheck = {
      checkId: checkId(identityId, now),
      identityId,
      checkedAt: new Date(now).toISOString(),
      state,
      expectedHandle: normalizeSocialHandle(identity.expectedHandle),
      ...(result.observedHandle ? { observedHandle: normalizeSocialHandle(result.observedHandle) } : {}),
      ...(result.currentUrl ? { currentUrl: result.currentUrl } : {}),
      ...(note ? { note } : {})
    };
    return this.store.recordSessionHealth(check, actor);
  }
}

export class AccountIdentityGuard {
  constructor(private readonly store: BrowserIdentityStorePort) {}

  assertReady(identityId: string): SessionHealthCheck {
    const identity = this.store.getBrowserIdentity(identityId);
    if (!identity) throw new Error(`Unknown browser identity: ${identityId}`);
    if (!identity.identity.enabled) throw new SessionNotReadyError(`Browser identity ${identityId} is disabled`);
    const account = this.store.getSocialAccount(identity.identity.accountId);
    if (!account) throw new SessionNotReadyError(`Social account ${identity.identity.accountId} is missing`);
    if (!account.account.enabled) throw new SessionNotReadyError(`Social account ${account.account.accountId} is disabled`);

    const latest = this.store.latestSessionHealth(identityId);
    if (!latest) throw new SessionNotReadyError(`Browser identity ${identityId} has no successful health check`);
    if (latest.state === "IDENTITY_MISMATCH") {
      throw new AccountIdentityMismatchError(latest.note ?? `Browser identity ${identityId} account mismatch`);
    }
    if (latest.state !== "HEALTHY") {
      throw new SessionNotReadyError(`Browser identity ${identityId} is not healthy: ${latest.state}`);
    }
    return latest;
  }
}

export function validateBrowserIdentityRegistration(identity: BrowserIdentity, accountPlatform: string, accountHandle: string): void {
  if (identity.platform !== accountPlatform) {
    throw new Error(`Browser identity platform ${identity.platform} does not match account platform ${accountPlatform}`);
  }
  if (normalizeSocialHandle(identity.expectedHandle) !== normalizeSocialHandle(accountHandle)) {
    throw new Error("Browser identity expectedHandle must match social account expectedHandle");
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/.test(identity.profileKey) || identity.profileKey.includes("..")) {
    throw new Error(`Unsafe browser profile key: ${identity.profileKey}`);
  }
}
