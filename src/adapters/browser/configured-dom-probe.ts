import type { BrowserIdentity, SessionProbeResult } from "../../domain/browser-identity.js";
import type { BrowserPageSessionPort, SessionProbePort } from "../../domain/browser-identity-ports.js";

export interface ConfiguredDomSessionProbeConfig {
  probeUrl: string;
  identitySelector: string;
  identityAttribute?: string;
  authUrlIncludes?: readonly string[];
  challengeUrlIncludes?: readonly string[];
  authSelector?: string;
  challengeSelector?: string;
  settleMs?: number;
  navigate?: boolean;
  /**
   * How long to keep looking for the identity marker before giving up.
   *
   * A single check after a fixed settle is a race against the platform's own rendering: the
   * Instagram settings page needed roughly 1.7s to attach its profile anchor while the probe
   * looked once at 1.0s and reported UNKNOWN on a perfectly healthy session. Auth and challenge
   * states are still decided immediately, so a logged-out page never waits this out.
   */
  identityTimeoutMs?: number;
  identityPollMs?: number;
}

function stringLiteral(value: string): string {
  return JSON.stringify(value);
}

export class ConfiguredDomSessionProbe implements SessionProbePort {
  constructor(private readonly config: ConfiguredDomSessionProbeConfig) {}

  async probe(session: BrowserPageSessionPort, _identity: BrowserIdentity): Promise<SessionProbeResult> {
    try {
      if (this.config.navigate ?? true) await session.navigate(this.config.probeUrl);
      if ((this.config.settleMs ?? 0) > 0) {
        await session.evaluate(`new Promise(resolve => setTimeout(resolve, ${Math.trunc(this.config.settleMs ?? 0)}))`);
      }
      const selector = stringLiteral(this.config.identitySelector);
      const attribute = this.config.identityAttribute ? stringLiteral(this.config.identityAttribute) : null;
      const expression = `(() => {
        const el = document.querySelector(${selector});
        if (!el) return null;
        const attribute = ${attribute ?? "null"};
        return attribute ? el.getAttribute(attribute) : (el.textContent || "").trim();
      })()`;

      // Bounded wait rather than one look after a fixed settle. Auth and challenge are still
      // decided on the first pass they appear, so a logged-out page returns immediately and never
      // burns the budget.
      const deadline = Date.now() + (this.config.identityTimeoutMs ?? 8_000);
      const pollMs = Math.max(100, this.config.identityPollMs ?? 250);
      let currentUrl = await session.currentUrl();
      for (;;) {
        currentUrl = await session.currentUrl();
        const normalized = currentUrl.toLocaleLowerCase("en-US");
        if ((this.config.challengeUrlIncludes ?? []).some((part) => normalized.includes(part.toLocaleLowerCase("en-US")))) {
          return { state: "CHALLENGE", currentUrl, note: "Challenge URL detected" };
        }
        if ((this.config.authUrlIncludes ?? []).some((part) => normalized.includes(part.toLocaleLowerCase("en-US")))) {
          return { state: "AUTH_REQUIRED", currentUrl, note: "Authentication URL detected" };
        }
        if (this.config.challengeSelector) {
          const challengeExists = await session.evaluate<boolean>(`Boolean(document.querySelector(${stringLiteral(this.config.challengeSelector)}))`);
          if (challengeExists) return { state: "CHALLENGE", currentUrl, note: "Challenge marker detected" };
        }
        if (this.config.authSelector) {
          const authExists = await session.evaluate<boolean>(`Boolean(document.querySelector(${stringLiteral(this.config.authSelector)}))`);
          if (authExists) return { state: "AUTH_REQUIRED", currentUrl, note: "Authentication marker detected" };
        }
        const observedHandle = await session.evaluate<string | null>(expression);
        if (observedHandle) return { state: "HEALTHY", currentUrl, observedHandle };
        if (Date.now() >= deadline) {
          return { state: "UNKNOWN", currentUrl, note: `Identity selector not found within the bounded wait: ${this.config.identitySelector}` };
        }
        await session.evaluate(`new Promise(resolve => setTimeout(resolve, ${pollMs}))`);
      }
    } catch (error) {
      return {
        state: "UNREACHABLE",
        note: error instanceof Error ? error.message : String(error)
      };
    }
  }
}
