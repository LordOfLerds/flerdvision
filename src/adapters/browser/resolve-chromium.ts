import { accessSync, constants } from "node:fs";

// Deployment targets differ: acceptance may run on macOS while production runs on Linux.
// A hard-coded executable path silently ties the whole browser subsystem to one of them.
export const LINUX_CHROMIUM_CANDIDATES: readonly string[] = [
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/snap/bin/chromium"
];

export const DARWIN_CHROMIUM_CANDIDATES: readonly string[] = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary"
];

export function chromiumCandidates(osPlatform: string = process.platform): readonly string[] {
  return osPlatform === "darwin" ? DARWIN_CHROMIUM_CANDIDATES : LINUX_CHROMIUM_CANDIDATES;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The browser that this host is actually allowed to use, or undefined.
 *
 * An explicit CHROMIUM_EXECUTABLE_PATH is authoritative: when it is configured but not
 * executable, preflight/doctor must report that misconfiguration instead of silently falling
 * back to a different host browser. Without an explicit path, normal platform discovery applies.
 */
export function findChromiumExecutable(
  env: Record<string, string | undefined> = process.env,
  osPlatform: string = process.platform
): string | undefined {
  const configured = env.CHROMIUM_EXECUTABLE_PATH;
  if (configured) return isExecutable(configured) ? configured : undefined;
  return chromiumCandidates(osPlatform).find(isExecutable);
}

/**
 * A definite path for spawning. An explicit CHROMIUM_EXECUTABLE_PATH is honoured even when it is
 * not executable, so a misconfigured deployment fails naming the path the operator actually set
 * instead of a platform default they never chose.
 */
export function resolveChromiumExecutablePath(
  env: Record<string, string | undefined> = process.env,
  osPlatform: string = process.platform
): string {
  const configured = env.CHROMIUM_EXECUTABLE_PATH;
  if (configured) return configured;
  return findChromiumExecutable(env, osPlatform) ?? chromiumCandidates(osPlatform)[0]!;
}
