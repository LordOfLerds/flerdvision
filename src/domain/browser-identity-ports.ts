import type { Actor } from "./control-plane.js";
import type { Instant } from "./model.js";
import type {
  BrowserIdentity,
  SessionHealthCheck,
  SessionProbeResult,
  SocialAccount,
  StoredBrowserIdentity,
  StoredSocialAccount
} from "./browser-identity.js";

export interface BrowserIdentityStorePort {
  registerSocialAccount(account: SocialAccount, now: Instant, actor: Actor): { created: boolean; record: StoredSocialAccount };
  getSocialAccount(accountId: string): StoredSocialAccount | null;
  listSocialAccounts(): readonly StoredSocialAccount[];
  registerBrowserIdentity(identity: BrowserIdentity, now: Instant, actor: Actor): { created: boolean; record: StoredBrowserIdentity };
  getBrowserIdentity(identityId: string): StoredBrowserIdentity | null;
  listBrowserIdentities(): readonly StoredBrowserIdentity[];
  recordSessionHealth(check: SessionHealthCheck, actor: Actor): SessionHealthCheck;
  latestSessionHealth(identityId: string): SessionHealthCheck | null;
  listSessionHealth(identityId?: string): readonly SessionHealthCheck[];
}

export interface BrowserCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
}

export interface BrowserPageSessionPort {
  readonly identityId: string;
  readonly profileDirectory: string;
  navigate(url: string): Promise<void>;
  currentUrl(): Promise<string>;
  evaluate<T>(expression: string): Promise<T>;
  setInputFiles(selector: string, filePaths: readonly string[]): Promise<void>;
  captureScreenshot(filePath: string): Promise<void>;
  setCookie(url: string, name: string, value: string, expires?: number): Promise<void>;
  cookies(url: string): Promise<readonly BrowserCookie[]>;
  close(): Promise<void>;
}

export interface BrowserRuntimeLaunchOptions {
  headless: boolean;
  initialUrl: string;
}

export interface BrowserRuntimePort {
  launch(identity: BrowserIdentity, options: BrowserRuntimeLaunchOptions): Promise<BrowserPageSessionPort>;
}

export interface SessionProbePort {
  probe(session: BrowserPageSessionPort, identity: BrowserIdentity): Promise<SessionProbeResult>;
}

export interface BrowserProfileLock {
  identityId: string;
  ownerId: string;
  heartbeat(now: Instant): void;
  release(): void;
}

export interface BrowserProfileLockPort {
  acquire(identity: BrowserIdentity, ownerId: string, now: Instant): BrowserProfileLock;
}
