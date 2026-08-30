import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { ChromiumCdpRuntimeAdapter } from "../adapters/browser/chromium-cdp.js";
import { ConfiguredDomSessionProbe, type ConfiguredDomSessionProbeConfig } from "../adapters/browser/configured-dom-probe.js";
import { BrowserProfileDirectoryResolver, DurableBrowserProfileLockAdapter, FileBrowserProfileLockAdapter } from "../adapters/browser/profile-lock.js";
import { resolveChromiumExecutablePath } from "../adapters/browser/resolve-chromium.js";
import { SqliteControlPlaneStore } from "../adapters/storage/sqlite.js";
import { BrowserBootstrapService } from "./browser-bootstrap.js";
import { AccountIdentityGuard, BrowserSessionHealthService } from "./browser-identity-service.js";
import { loadWorkspaceSpecFile } from "./headless-bootstrap.js";
import { workspaceRuntimeLayout } from "./workspaces.js";
import { accountIdForChannel, identityIdForChannel } from "./workspace-spec-compiler.js";
import type { WorkspaceChannelSpec } from "../domain/workspace-spec.js";

export interface HeadlessLoginResult {
  channelKey: string;
  accountId: string;
  identityId: string;
  observedHandle: string;
  checkedAt: string;
  profileDirectory: string;
}

function bootstrapUrl(channel: WorkspaceChannelSpec): string {
  if (channel.platform === "instagram") return "https://www.instagram.com/";
  if (channel.platform === "tiktok") return "https://www.tiktok.com/";
  return "https://studio.youtube.com/";
}
/**
 * The page an identity probe must look at.
 *
 * Instagram is checked on the account-settings page rather than the feed. On the feed a link to
 * /<handle>/ proves nothing about who is logged in -- a post by that account renders the same
 * markup -- so the old selector leaned on a nav ancestor for self-scoping, and Instagram has
 * since moved the profile link out of any nav or [role=navigation]. The settings page exists
 * only for the authenticated account, so the page itself supplies the self-scoping. A logged-out
 * or wrong-account visitor is redirected to the login URL and classified AUTH_REQUIRED.
 */
function identityUrl(channel: WorkspaceChannelSpec): string {
  if (channel.platform === "instagram") return "https://www.instagram.com/accounts/edit/";
  return bootstrapUrl(channel);
}
function identitySelector(channel: WorkspaceChannelSpec): string {
  const handle = channel.handle.replace(/["\\]/g, "");
  // Scoped by identityUrl above; a nav ancestor is no longer part of Instagram's markup.
  if (channel.platform === "instagram") return `a[href="/${handle}/"]`;
  // TIKTOK-LIVE-CALIBRATION: this probe is UNVERIFIED against the live TikTok DOM and shares
  // the two defect classes the Instagram probe was repaired for.
  //
  // 1. Not fully self-scoped: identityUrl for TikTok is the root feed. A bare a[href*="/@handle"]
  //    would match the author link of any of the account's videos surfacing in the feed while a
  //    DIFFERENT account is logged in, so the selector keeps its structural guards (nav ancestor,
  //    or a data-e2e attribute containing "profile") -- never weaken it to an unscoped anchor.
  //    The sound fix mirrors Instagram: probe a page that exists only for the authenticated
  //    account and shows its own handle. Which TikTok page that is (settings, TikTok Studio, the
  //    upload shell) must be decided from a live snapshot, not guessed here.
  // 2. Possibly dead: whether TikTok's desktop shell still renders a <nav> ancestor or a
  //    data-e2e*="profile" attribute on the own-profile link is unknown until a live snapshot
  //    exists -- exactly how Instagram's nav ancestor silently died.
  //
  // Both failure modes are fail-closed today: a selector that matches nothing yields
  // UNKNOWN/AUTH_REQUIRED, never HEALTHY, and the login loop times out instead of passing. The
  // sessionid cookie gate below additionally keeps the browser untouched until authentication
  // actually happened. Calibrate against the live surface during the first TikTok acceptance.
  if (channel.platform === "tiktok") return `nav a[href*="/@${handle}"], a[data-e2e*="profile"][href*="/@${handle}"]`;
  return `a[href*="/@${handle}"], a[href*="/channel/"][aria-label*="${handle}"]`;
}
function probeConfig(channel: WorkspaceChannelSpec, navigate: boolean): ConfiguredDomSessionProbeConfig {
  return {
    probeUrl: identityUrl(channel),
    identitySelector: identitySelector(channel),
    identityAttribute: "href",
    authUrlIncludes: channel.platform === "instagram" ? ["/accounts/login"] : channel.platform === "tiktok" ? ["/login"] : ["accounts.google.com"],
    challengeUrlIncludes: channel.platform === "instagram" ? ["/challenge/"] : channel.platform === "tiktok" ? ["/verify"] : [],
    settleMs: 1000,
    navigate
  };
}
function writeCalibratedProbe(path: string, channel: WorkspaceChannelSpec, accountId: string, checkedAt: string): void {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { schemaVersion: number; probes: Record<string, unknown>[] };
  const probes = parsed.probes.map((entry) => {
    if (entry.accountId !== accountId || entry.platform !== channel.platform) return entry;
    return {
      ...entry,
      calibrationStatus: "CALIBRATED",
      calibratedAt: checkedAt,
      calibratedBy: "headless-login",
      config: probeConfig(channel, true)
    };
  });
  const temp = `${path}.tmp-${Date.now()}`;
  writeFileSync(temp, `${JSON.stringify({ schemaVersion: 1, probes }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temp, path);
}

export async function ensureHeadlessLogin(input: {
  specPath: string;
  channelKey: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  pollMs?: number;
  onProgress?: (message: string) => void;
}): Promise<HeadlessLoginResult> {
  const spec = loadWorkspaceSpecFile(input.specPath);
  const channel = spec.channels.find((item) => item.key === input.channelKey);
  if (!channel) throw new Error(`Unknown channel key: ${input.channelKey}`);
  const runtimeRoot = resolve(spec.workspace.runtimeRoot);
  const layout = workspaceRuntimeLayout(runtimeRoot, spec.workspace.id);
  const control = new SqliteControlPlaneStore(layout.databasePath);
  const accountId = accountIdForChannel(channel);
  const identityId = identityIdForChannel(channel);
  const identity = control.getBrowserIdentity(identityId)?.identity;
  if (!identity || identity.accountId !== accountId) { control.close(); throw new Error(`Run headless bootstrap before login; browser identity ${identityId} is missing`); }
  const env = input.env ?? process.env;
  const runtime = new ChromiumCdpRuntimeAdapter({ profilesRoot: layout.profilesDir, executablePath: env.CHROMIUM_EXECUTABLE_PATH ?? resolveChromiumExecutablePath() });
  const resolver = new BrowserProfileDirectoryResolver(layout.profilesDir);
  const locks = new DurableBrowserProfileLockAdapter(control, new FileBrowserProfileLockAdapter(resolver));
  const bootstrap = new BrowserBootstrapService(control, runtime, locks);
  const session = await bootstrap.openForOperator({ identityId, ownerId: `headless-login:${channel.key}`, bootstrapUrl: bootstrapUrl(channel), now: new Date().toISOString(), headless: false });
  const started = Date.now();
  let lastState = "UNKNOWN";
  try {
    input.onProgress?.(`Browser opened for ${channel.platform}/@${channel.handle}; complete normal login and 2FA. Detection is automatic.`);
    const timeoutMs = input.timeoutMs ?? 15 * 60_000;
    // The URL allowlist alone proved insufficient: Instagram's code-entry pages live on paths
    // the list does not know (auth_platform and friends), so the probe navigated the operator
    // away mid-2FA every few seconds. The platform's own session cookie is the honest signal --
    // it exists exactly from the moment authentication succeeded. Until it does, the browser is
    // the operator's alone: no navigation, no probing, nothing.
    const sessionCookie = channel.platform === "instagram" || channel.platform === "tiktok" ? "sessionid" : null;
    while (Date.now() - started < timeoutMs) {
      const checkedAt = new Date().toISOString();
      if (sessionCookie) {
        const authenticated = await session.page.cookies(bootstrapUrl(channel))
          .then((cookies) => cookies.some((cookie) => cookie.name === sessionCookie && cookie.value.length > 0))
          .catch(() => false);
        if (!authenticated) {
          if (lastState !== "AWAITING_LOGIN") {
            lastState = "AWAITING_LOGIN";
            input.onProgress?.(`Login state ${channel.key}: waiting for the operator to finish signing in (no ${sessionCookie} cookie yet; the browser will not be touched)`);
          }
          session.heartbeat(checkedAt);
          await sleep(input.pollMs ?? 2000);
          continue;
        }
      }
      // Legacy guard for platforms without a known session cookie.
      const currentUrl = await session.page.currentUrl().catch(() => "");
      const inLoginFlow = currentUrl.includes("/accounts/login") || currentUrl.includes("/challenge/") || currentUrl.includes("/login") || currentUrl.includes("accounts.google.com");
      const check = await new BrowserSessionHealthService(control, new ConfiguredDomSessionProbe(probeConfig(channel, !inLoginFlow))).check(
        identityId,
        session.page,
        checkedAt,
        { type: "operator", id: "headless-login" }
      );
      if (check.state !== lastState) {
        lastState = check.state;
        input.onProgress?.(`Login state ${channel.key}: ${check.state}${check.note ? ` · ${check.note}` : ""}`);
      }
      if (check.state === "IDENTITY_MISMATCH") throw new Error(check.note ?? `Logged-in account does not match @${channel.handle}`);
      if (check.state === "HEALTHY") {
        const proven = new AccountIdentityGuard(control).assertReady(identityId);
        if (!proven.observedHandle) throw new Error("Healthy session did not persist an observed handle");
        writeCalibratedProbe(resolve(layout.configDir, "session-probes.json"), channel, accountId, checkedAt);
        input.onProgress?.(`Verified ${channel.platform} account @${proven.observedHandle}.`);
        return { channelKey: channel.key, accountId, identityId, observedHandle: proven.observedHandle, checkedAt, profileDirectory: session.profileDirectory };
      }
      session.heartbeat(checkedAt);
      await sleep(input.pollMs ?? 2000);
    }
    // The operator has to find the window, type a password and clear 2FA. Saying how long we
    // waited and how to wait longer is the difference between a dead end and a retry.
    throw new Error(
      `Login verification timed out for ${channel.key} after ${Math.round(timeoutMs / 60_000)} minutes. ` +
      `The browser profile showed no verified @${channel.handle} session. ` +
      `Re-run with --login-timeout <minutes> if more time is needed.`
    );
  } finally {
    await session.close().catch(() => {});
    control.close();
  }
}
