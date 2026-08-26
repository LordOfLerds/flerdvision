import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { HttpJsonPort, HttpJsonResponse } from "../../../domain/source-folder-ports.js";
import { SourceBrowseError } from "../../../domain/source-folder.js";

export interface StoredDriveCredential {
  clientId: string;
  refreshToken: string;
  connectedAccount?: string;
  connectedAt: string;
}

/**
 * Holds the workspace's Drive refresh token.
 *
 * The token lives in the workspace's own config directory, owner-readable only, and never leaves
 * this module towards a rendered page: the UI is told whether a workspace is connected and to
 * which account, never the secret itself.
 */
export class FileDriveCredentialStore {
  constructor(private readonly configDir: string) {}

  private get path(): string {
    return resolve(this.configDir, "drive-credential.json");
  }

  read(): StoredDriveCredential | null {
    if (!existsSync(this.path)) return null;
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as StoredDriveCredential;
      if (!parsed.refreshToken || !parsed.clientId) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  write(credential: StoredDriveCredential): void {
    writeFileSync(this.path, JSON.stringify(credential, null, 2), { encoding: "utf8", mode: 0o600 });
  }

  /** What the UI is allowed to see. */
  status(): { connected: boolean; connectedAccount?: string; connectedAt?: string } {
    const credential = this.read();
    if (!credential) return { connected: false };
    return {
      connected: true,
      ...(credential.connectedAccount ? { connectedAccount: credential.connectedAccount } : {}),
      connectedAt: credential.connectedAt
    };
  }
}

/** Reads the OAuth client from deployment configuration, never from source control. */
export function driveOAuthClientFromEnv(
  env: Record<string, string | undefined>,
  redirectUri: string
): { clientId: string; clientSecret: string; redirectUri: string } | null {
  const clientId = env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret, redirectUri };
}

/** The one place this codebase reaches the network for JSON. */
export class FetchHttpJson implements HttpJsonPort {
  constructor(private readonly timeoutMs: number = 20_000) {}

  private async send(url: string, init: RequestInit): Promise<HttpJsonResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      const text = await response.text();
      let body: unknown = null;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          throw new SourceBrowseError(`Expected JSON from ${url} but got ${text.slice(0, 120)}`);
        }
      }
      return { status: response.status, body };
    } finally {
      clearTimeout(timer);
    }
  }

  async getJson(url: string, headers: Readonly<Record<string, string>>): Promise<HttpJsonResponse> {
    return await this.send(url, { method: "GET", headers: { ...headers } });
  }

  async postForm(url: string, form: Readonly<Record<string, string>>): Promise<HttpJsonResponse> {
    return await this.send(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams(form).toString()
    });
  }
}
