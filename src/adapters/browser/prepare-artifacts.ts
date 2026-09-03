import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { BrowserIdentity } from "../../domain/browser-identity.js";
import type { BrowserPageSessionPort } from "../../domain/browser-identity-ports.js";
import type { PublicationIntent } from "../../domain/model.js";
import type { PrepareArtifactSinkPort } from "../../domain/platform-ui-ports.js";

function safeSegment(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
  return safe || "artifact";
}

export class LocalPrepareArtifactSink implements PrepareArtifactSinkPort {
  private readonly root: string;

  constructor(rootDirectory: string) {
    this.root = resolve(rootDirectory);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }

  /** Recordings land with the screenshots of the same intent, and are pruned there. */
  recordingDirectory(intent: PublicationIntent): string {
    const directory = join(this.root, safeSegment(intent.intentId));
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    return directory;
  }

  async captureBoundary(
    session: BrowserPageSessionPort,
    intent: PublicationIntent,
    identity: BrowserIdentity,
    label: string,
    now: string
  ): Promise<readonly string[]> {
    const directory = join(this.root, safeSegment(intent.intentId));
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stamp = safeSegment(new Date(now).toISOString());
    const base = `${stamp}-${safeSegment(label)}`;
    const screenshotPath = join(directory, `${base}.png`);
    const domPath = join(directory, `${base}.html`);
    const metaPath = join(directory, `${base}.json`);

    await session.captureScreenshot(screenshotPath);
    const dom = await session.evaluate<string>("document.documentElement.outerHTML");
    writeFileSync(domPath, dom, { encoding: "utf8", mode: 0o600 });
    writeFileSync(metaPath, JSON.stringify({
      capturedAt: new Date(now).toISOString(),
      intentId: intent.intentId,
      accountId: intent.accountId,
      platform: intent.platform,
      format: intent.format,
      identityId: identity.identityId,
      currentUrl: await session.currentUrl(),
      label
    }, null, 2), { encoding: "utf8", mode: 0o600 });
    return [screenshotPath, domPath, metaPath];
  }

  async writeJournal(intent: PublicationIntent, entries: readonly unknown[], now: string): Promise<string> {
    const directory = join(this.root, safeSegment(intent.intentId));
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `${safeSegment(new Date(now).toISOString())}-action-journal.json`);
    writeFileSync(path, JSON.stringify({ intentId: intent.intentId, entries }, null, 2), { encoding: "utf8", mode: 0o600 });
    return path;
  }
}

/**
 * The newest MP4 a run left beside an intent's screenshots, or undefined. The operator asked for
 * the video of every real post in the chat; the message builder asks here, and a missing file
 * degrades the message to text, never the publishing cycle.
 */
export function findLatestRecording(rootDirectory: string, intentId: string): string | undefined {
  const directory = join(resolve(rootDirectory), safeSegment(intentId));
  let newest: { path: string; mtime: number } | undefined;
  try {
    for (const name of readdirSync(directory)) {
      if (!name.startsWith("screencast-") || !name.endsWith(".mp4")) continue;
      const path = join(directory, name);
      const mtime = new Date(statSync(path).mtime.toISOString()).getTime();
      if (!newest || mtime > newest.mtime) newest = { path, mtime };
    }
  } catch {
    return undefined;
  }
  return newest?.path;
}
