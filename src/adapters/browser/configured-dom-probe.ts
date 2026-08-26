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
      const currentUrl = await session.currentUrl();
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

      const selector = stringLiteral(this.config.identitySelector);
      const attribute = this.config.identityAttribute ? stringLiteral(this.config.identityAttribute) : null;
      const expression = `(() => {
        const el = document.querySelector(${selector});
        if (!el) return null;
        const attribute = ${attribute ?? "null"};
        return attribute ? el.getAttribute(attribute) : (el.textContent || "").trim();
      })()`;
      const observedHandle = await session.evaluate<string | null>(expression);
      if (!observedHandle) {
        return { state: "UNKNOWN", currentUrl, note: `Identity selector not found: ${this.config.identitySelector}` };
      }
      return { state: "HEALTHY", currentUrl, observedHandle };
    } catch (error) {
      return {
        state: "UNREACHABLE",
        note: error instanceof Error ? error.message : String(error)
      };
    }
  }
}
