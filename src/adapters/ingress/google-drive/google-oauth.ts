import { createHash, randomBytes } from "node:crypto";
import type { HttpJsonPort, SourceAccessTokenPort } from "../../../domain/source-folder-ports.js";
import { SourceAuthError } from "../../../domain/source-folder.js";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

/** Read-only: Flerdvision observes the source, it never writes back to it. */
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";

export interface GoogleOAuthClient {
  clientId: string;
  /** Installed-app clients still get a secret; it is not confidential, PKCE carries the security. */
  clientSecret: string;
  redirectUri: string;
}

export interface PendingAuthorization {
  state: string;
  codeVerifier: string;
  authorizationUrl: string;
}

export interface GoogleTokenSet {
  accessToken: string;
  expiresAt: number;
  refreshToken?: string;
}

function randomBase64Url(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

/**
 * Loopback authorization for a locally installed app.
 *
 * The setup UI already listens on 127.0.0.1, so it can host the redirect itself. PKCE means the
 * authorization code is useless to anything that did not start the flow, which matters because a
 * loopback redirect is reachable by every process on the machine.
 */
export function beginAuthorization(client: GoogleOAuthClient): PendingAuthorization {
  const codeVerifier = randomBase64Url(48);
  const state = randomBase64Url(16);
  const challenge = createHash("sha256").update(codeVerifier).digest("base64url");
  const params = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    response_type: "code",
    scope: DRIVE_SCOPE,
    code_challenge: challenge,
    code_challenge_method: "S256",
    access_type: "offline",
    // Without this an already-consented account returns no refresh token, and the workspace
    // would silently lose access the first time the access token expires.
    prompt: "consent",
    state
  });
  return { state, codeVerifier, authorizationUrl: `${AUTH_ENDPOINT}?${params.toString()}` };
}

function tokenSetFrom(body: unknown, now: number): GoogleTokenSet {
  const record = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const accessToken = record.access_token;
  if (typeof accessToken !== "string" || !accessToken) {
    const detail = typeof record.error_description === "string" ? record.error_description
      : typeof record.error === "string" ? record.error : "no access_token in response";
    throw new SourceAuthError(`Google token exchange failed: ${detail}`);
  }
  const expiresIn = typeof record.expires_in === "number" ? record.expires_in : 3600;
  const refresh = record.refresh_token;
  return {
    accessToken,
    expiresAt: now + expiresIn * 1000,
    ...(typeof refresh === "string" && refresh ? { refreshToken: refresh } : {})
  };
}

export async function exchangeAuthorizationCode(params: {
  http: HttpJsonPort;
  client: GoogleOAuthClient;
  code: string;
  codeVerifier: string;
  now: number;
}): Promise<GoogleTokenSet> {
  const response = await params.http.postForm(TOKEN_ENDPOINT, {
    client_id: params.client.clientId,
    client_secret: params.client.clientSecret,
    code: params.code,
    code_verifier: params.codeVerifier,
    grant_type: "authorization_code",
    redirect_uri: params.client.redirectUri
  });
  const tokens = tokenSetFrom(response.body, params.now);
  if (!tokens.refreshToken) {
    throw new SourceAuthError("Google returned no refresh token; the workspace could not stay connected.");
  }
  return tokens;
}

export async function refreshAccessToken(params: {
  http: HttpJsonPort;
  client: GoogleOAuthClient;
  refreshToken: string;
  now: number;
}): Promise<GoogleTokenSet> {
  const response = await params.http.postForm(TOKEN_ENDPOINT, {
    client_id: params.client.clientId,
    client_secret: params.client.clientSecret,
    refresh_token: params.refreshToken,
    grant_type: "refresh_token"
  });
  return tokenSetFrom(response.body, params.now);
}

export interface RefreshingTokenConfig {
  http: HttpJsonPort;
  client: GoogleOAuthClient;
  refreshToken: string;
  /** Injected so tests do not depend on the wall clock. */
  clock?: () => number;
  /** Refresh this long before expiry so a request never races the boundary. */
  skewMs?: number;
}

/** Caches an access token and refreshes it just before it lapses. */
export class RefreshingAccessToken implements SourceAccessTokenPort {
  private cached: GoogleTokenSet | undefined;
  private readonly clock: () => number;
  private readonly skewMs: number;

  constructor(private readonly config: RefreshingTokenConfig) {
    this.clock = config.clock ?? (() => Date.now());
    this.skewMs = config.skewMs ?? 60_000;
  }

  async accessToken(): Promise<string> {
    const now = this.clock();
    if (this.cached && this.cached.expiresAt - this.skewMs > now) return this.cached.accessToken;
    this.cached = await refreshAccessToken({
      http: this.config.http,
      client: this.config.client,
      refreshToken: this.config.refreshToken,
      now
    });
    return this.cached.accessToken;
  }
}
