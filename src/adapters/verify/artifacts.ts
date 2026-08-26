import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { BrowserIdentity } from "../../domain/browser-identity.js";
import type { BrowserPageSessionPort } from "../../domain/browser-identity-ports.js";
import type { PublicationIntent, PublishAttempt } from "../../domain/model.js";
import type { VerificationArtifactSinkPort } from "../../domain/verification-ports.js";

function safe(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "artifact";
}

export class LocalVerificationArtifactSink implements VerificationArtifactSinkPort {
  private readonly root: string;

  constructor(rootDirectory: string) {
    this.root = resolve(rootDirectory);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }

  async capture(
    session: BrowserPageSessionPort,
    intent: PublicationIntent,
    identity: BrowserIdentity,
    attempt: PublishAttempt,
    label: string,
    now: string
  ): Promise<readonly string[]> {
    const directory = join(this.root, safe(intent.intentId), safe(attempt.attemptId));
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const base = `${safe(new Date(now).toISOString())}-${safe(label)}`;
    const screenshot = join(directory, `${base}.png`);
    const dom = join(directory, `${base}.html`);
    const meta = join(directory, `${base}.json`);
    await session.captureScreenshot(screenshot);
    writeFileSync(dom, await session.evaluate<string>("document.documentElement.outerHTML"), { encoding: "utf8", mode: 0o600 });
    writeFileSync(meta, JSON.stringify({
      capturedAt: new Date(now).toISOString(), intentId: intent.intentId, attemptId: attempt.attemptId,
      accountId: intent.accountId, identityId: identity.identityId, platform: intent.platform,
      currentUrl: await session.currentUrl(), label
    }, null, 2), { encoding: "utf8", mode: 0o600 });
    return [screenshot, dom, meta];
  }

  async writeManualEvidence(
    intent: PublicationIntent,
    attempt: PublishAttempt,
    payload: Readonly<Record<string, unknown>>,
    now: string
  ): Promise<string> {
    const directory = join(this.root, safe(intent.intentId), safe(attempt.attemptId));
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `${safe(new Date(now).toISOString())}-manual-verification.json`);
    writeFileSync(path, JSON.stringify({ intentId: intent.intentId, attemptId: attempt.attemptId, recordedAt: new Date(now).toISOString(), payload }, null, 2), { encoding: "utf8", mode: 0o600 });
    return path;
  }
}
