import type {
  BrowserIdentityStorePort,
  BrowserPageSessionPort,
  BrowserProfileLock,
  BrowserProfileLockPort,
  BrowserRuntimePort
} from "../domain/browser-identity-ports.js";

export interface OperatorBrowserSession {
  identityId: string;
  accountId: string;
  profileDirectory: string;
  page: BrowserPageSessionPort;
  heartbeat(now: string): void;
  close(): Promise<void>;
}

export class BrowserBootstrapService {
  constructor(
    private readonly store: BrowserIdentityStorePort,
    private readonly runtime: BrowserRuntimePort,
    private readonly profileLocks: BrowserProfileLockPort
  ) {}

  async openForOperator(params: {
    identityId: string;
    ownerId: string;
    bootstrapUrl: string;
    now: string;
    headless?: boolean;
  }): Promise<OperatorBrowserSession> {
    const stored = this.store.getBrowserIdentity(params.identityId);
    if (!stored) throw new Error(`Unknown browser identity: ${params.identityId}`);
    if (!stored.identity.enabled) throw new Error(`Browser identity ${params.identityId} is disabled`);
    const account = this.store.getSocialAccount(stored.identity.accountId);
    if (!account) throw new Error(`Missing social account: ${stored.identity.accountId}`);
    if (!account.account.enabled) throw new Error(`Social account ${account.account.accountId} is disabled`);

    let lock: BrowserProfileLock | null = this.profileLocks.acquire(stored.identity, params.ownerId, params.now);
    try {
      const page = await this.runtime.launch(stored.identity, {
        headless: params.headless ?? false,
        initialUrl: params.bootstrapUrl
      });
      let closed = false;
      return {
        identityId: stored.identity.identityId,
        accountId: stored.identity.accountId,
        profileDirectory: page.profileDirectory,
        page,
        heartbeat(heartbeatAt: string) { lock?.heartbeat(heartbeatAt); },
        async close() {
          if (closed) return;
          closed = true;
          try {
            await page.close();
          } finally {
            lock?.release();
            lock = null;
          }
        }
      };
    } catch (error) {
      lock.release();
      lock = null;
      throw error;
    }
  }
}
