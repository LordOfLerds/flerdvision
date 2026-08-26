import { SqliteControlPlaneStore } from "../adapters/storage/sqlite.js";
import { BrowserProfileDirectoryResolver, DurableBrowserProfileLockAdapter, FileBrowserProfileLockAdapter } from "../adapters/browser/profile-lock.js";
import { ChromiumCdpRuntimeAdapter } from "../adapters/browser/chromium-cdp.js";
import { ConfiguredDomSessionProbe } from "../adapters/browser/configured-dom-probe.js";
import { BrowserBootstrapService } from "../application/browser-bootstrap.js";
import { AccountIdentityGuard, BrowserSessionHealthService } from "../application/browser-identity-service.js";
import type { Platform } from "../domain/model.js";

function usage(message?: string): never {
  if (message) console.error(message);
  console.error(`Usage:
  browser register --account-id ID --identity-id ID --platform instagram|tiktok|youtube --expected-handle HANDLE --profile-key KEY [--creator-id ID] [--db PATH]
  browser list [--db PATH]
  browser bootstrap --identity-id ID --url URL [--profiles-root PATH] [--chromium PATH] [--headless] [--db PATH]
  browser probe --identity-id ID --url URL --selector CSS [--attribute NAME] [--auth-url PART] [--challenge-url PART] [--auth-selector CSS] [--challenge-selector CSS] [--headed] [--profiles-root PATH] [--chromium PATH] [--db PATH]
  browser guard --identity-id ID [--db PATH]
`);
  process.exitCode = 2;
  throw new Error("invalid arguments");
}

function flag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  return args[index + 1];
}

function has(args: readonly string[], name: string): boolean {
  return args.includes(name);
}

function required(args: readonly string[], name: string): string {
  const value = flag(args, name);
  if (!value) usage(`Missing ${name}`);
  return value;
}

function dbPath(args: readonly string[]): string {
  return flag(args, "--db") ?? process.env.FLERDVISION_DB_PATH ?? "runtime/flerdvision.sqlite";
}

function profilesRoot(args: readonly string[]): string {
  return flag(args, "--profiles-root") ?? process.env.FLERDVISION_PROFILES_ROOT ?? process.env.BROWSER_PROFILE_DIR ?? "profiles";
}

function chromiumPath(args: readonly string[]): string {
  return flag(args, "--chromium") ?? process.env.CHROMIUM_EXECUTABLE_PATH ?? "/usr/bin/chromium";
}

function platform(value: string): Platform {
  if (value === "instagram" || value === "tiktok" || value === "youtube") return value;
  usage(`Unsupported platform: ${value}`);
}

async function waitForCtrlC(): Promise<void> {
  console.log("Browser opened. Complete normal login/2FA in the browser. Press Ctrl+C here when finished.");
  await new Promise<void>((resolvePromise) => {
    process.on("SIGINT", () => resolvePromise());
    process.on("SIGTERM", () => resolvePromise());
  });
}

const args = process.argv.slice(2);
const command = args[0];
if (!command) usage();
const store = new SqliteControlPlaneStore(dbPath(args));
const actor = { type: "operator" as const, id: process.env.USER ?? "browser-cli" };

try {
  if (command === "register") {
    const accountId = required(args, "--account-id");
    const identityId = required(args, "--identity-id");
    const selectedPlatform = platform(required(args, "--platform"));
    const expectedHandle = required(args, "--expected-handle");
    const profileKey = required(args, "--profile-key");
    const creatorId = flag(args, "--creator-id");
    const now = new Date().toISOString();
    const account = store.registerSocialAccount({
      accountId,
      platform: selectedPlatform,
      expectedHandle,
      enabled: true,
      ...(creatorId ? { creatorId } : {})
    }, now, actor);
    const identity = store.registerBrowserIdentity({
      identityId,
      accountId,
      platform: selectedPlatform,
      profileKey,
      expectedHandle,
      enabled: true
    }, now, actor);
    console.log(JSON.stringify({ account, identity }, null, 2));
  } else if (command === "list") {
    console.log(JSON.stringify({
      accounts: store.listSocialAccounts(),
      identities: store.listBrowserIdentities().map((entry) => ({
        ...entry,
        latestHealth: store.latestSessionHealth(entry.identity.identityId)
      }))
    }, null, 2));
  } else if (command === "guard") {
    const identityId = required(args, "--identity-id");
    console.log(JSON.stringify(new AccountIdentityGuard(store).assertReady(identityId), null, 2));
  } else if (command === "bootstrap" || command === "probe") {
    const identityId = required(args, "--identity-id");
    const url = required(args, "--url");
    const root = profilesRoot(args);
    const resolver = new BrowserProfileDirectoryResolver(root);
    const locks = new DurableBrowserProfileLockAdapter(store, new FileBrowserProfileLockAdapter(resolver));
    const runtime = new ChromiumCdpRuntimeAdapter({
      profilesRoot: root,
      executablePath: chromiumPath(args)
    });
    const bootstrap = new BrowserBootstrapService(store, runtime, locks);
    const operatorSession = await bootstrap.openForOperator({
      identityId,
      ownerId: actor.id,
      bootstrapUrl: url,
      now: new Date().toISOString(),
      headless: command === "probe" ? !has(args, "--headed") : has(args, "--headless")
    });
    try {
      if (command === "bootstrap") {
        console.log(JSON.stringify({
          identityId: operatorSession.identityId,
          accountId: operatorSession.accountId,
          profileDirectory: operatorSession.profileDirectory,
          remoteDebugging: "localhost-only"
        }, null, 2));
        await waitForCtrlC();
      } else {
        const selector = required(args, "--selector");
        const probe = new ConfiguredDomSessionProbe({
          probeUrl: url,
          identitySelector: selector,
          ...(flag(args, "--attribute") ? { identityAttribute: flag(args, "--attribute")! } : {}),
          ...(flag(args, "--auth-url") ? { authUrlIncludes: [flag(args, "--auth-url")!] } : {}),
          ...(flag(args, "--challenge-url") ? { challengeUrlIncludes: [flag(args, "--challenge-url")!] } : {}),
          ...(flag(args, "--auth-selector") ? { authSelector: flag(args, "--auth-selector")! } : {}),
          ...(flag(args, "--challenge-selector") ? { challengeSelector: flag(args, "--challenge-selector")! } : {})
        });
        const health = await new BrowserSessionHealthService(store, probe).check(
          identityId,
          operatorSession.page,
          new Date().toISOString(),
          actor
        );
        console.log(JSON.stringify(health, null, 2));
        if (health.state !== "HEALTHY") process.exitCode = 1;
      }
    } finally {
      await operatorSession.close();
    }
  } else {
    usage(`Unknown command: ${command}`);
  }
} finally {
  store.close();
}
