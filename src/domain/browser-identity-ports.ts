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
  /**
   * Dispatch a trusted mouse click at viewport coordinates via the browser's input pipeline.
   * Optional: test fakes may omit it, in which case callers fall back to an in-page click().
   * Real platforms need it -- Instagram ignores synthetic events (isTrusted === false) entirely,
   * including a full pointerdown/mousedown/click sequence, so an in-page click can "succeed"
   * while the application does nothing.
   */
  clickAt?(x: number, y: number): Promise<void>;
  /**
   * Pin the page to exact viewport metrics (width/height/deviceScaleFactor) via emulation.
   * Layout-affecting metrics are part of the surface-contract fingerprint; establishing them
   * makes execution deterministic across window restores and displays. Optional for fakes.
   */
  setViewport?(viewport: { width: number; height: number; deviceScaleFactor: number }): Promise<void>;
  /**
   * Supplies a file through the platform's own file-chooser flow: interception is armed, the
   * caller's trusted click opens the chooser, and the file is attached to the node the page
   * itself nominated. Needed where writing the hidden input directly is ignored.
   */
  setInputFilesViaChooser?(filePaths: readonly string[], openChooser: () => Promise<void>, timeoutMs: number): Promise<void>;
  /**
   * Hands the file to the page through its own DataTransfer API (the drop path every uploader
   * supports), for surfaces that ignore a protocol-set file input. Streams in chunks so a real
   * video never has to fit into one protocol message.
   */
  setInputFilesInPage?(selector: string, filePath: string): Promise<void>;
  /**
   * Trusted key input. Rich editors (DraftJS, Lexical) own their content model and ignore text
   * inserted into a field they believe already holds something; clearing it the way a person
   * does -- select all, delete -- is the only honest way to replace pre-filled text.
   */
  pressKey?(key: "a" | "Delete" | "Backspace" | "Enter", modifiers?: { meta?: boolean; ctrl?: boolean }): Promise<void>;
  /**
   * Insert text through the browser's input pipeline into the focused element. Optional like
   * clickAt; needed because state-owning editors (Instagram's caption is a Lexical editor)
   * ignore synthetic textContent writes exactly as the platform ignores synthetic clicks.
   */
  insertText?(text: string): Promise<void>;
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
