# 12 — W3 Browser identity subsystem

Status: **implemented under local verification; no social account has been touched.**

## Purpose

W3 creates the stable runtime identity that later UI publishers must use. A browser identity is not a password and not an API credential. It is an isolated persistent Chromium profile bound to exactly one configured social account.

Core chain:

`SocialAccount -> BrowserIdentity -> persistent profile -> SessionHealthCheck -> AccountIdentityGuard`

No W3 component contains an upload or final-publish method.

## Domain rules

1. `SocialAccount.accountId` is the stable internal account identifier.
2. Exactly one `BrowserIdentity` may be registered for an account in the MVP.
3. A `profileKey` may belong to exactly one browser identity.
4. Expected handles are normalized and must match between account and browser identity.
5. A browser profile is never shared concurrently.
6. Session health is append-only evidence; it is never silently rewritten.
7. A publisher in W4+ must pass `AccountIdentityGuard` before any media preparation.
8. `HEALTHY` means the configured probe observed the exact expected account identity. Mere successful page load is insufficient.

## Session-health states

- `HEALTHY` — authenticated and exact expected handle observed.
- `AUTH_REQUIRED` — login is required.
- `CHALLENGE` — 2FA/challenge/re-authentication UI detected.
- `IDENTITY_MISMATCH` — authenticated account differs from the configured account.
- `UNREACHABLE` — browser/probe failed technically.
- `UNKNOWN` — page is reachable but identity cannot be proved.

Only `HEALTHY` passes the account identity guard.

## Profile and lock safety

The profile resolver confines every `profileKey` below a configured root and rejects absolute paths and path traversal.

Two lock layers exist:

1. filesystem lock — prevents two local Chromium processes opening the same profile;
2. durable DB lease — prevents two workers sharing one browser identity even when local lock roots differ.

The browser DevTools endpoint binds to `127.0.0.1` only. Do not expose it publicly.

## First registration

Example only; use stable deployment IDs, never customer credentials in source control.

```bash
npm run browser -- register \
  --account-id creator_example_instagram_primary \
  --identity-id browser_creator_example_instagram_primary \
  --platform instagram \
  --expected-handle example_handle \
  --profile-key instagram/creator_example_primary \
  --creator-id creator_example
```

This writes non-secret registry data only.

## Human bootstrap

Run through a private operator desktop/session on the server or worker host:

```bash
npm run browser -- bootstrap \
  --identity-id browser_creator_example_instagram_primary \
  --url https://www.instagram.com/
```

The browser is a normal headed Chromium instance using the persistent profile. The human performs login/2FA normally. Do **not** save the password in source control, CLI arguments, screenshots or incident bundles. Close the bootstrap with Ctrl+C after the session is established.

A later platform probe then verifies the exact account. W3 provides the generic probe/guard machinery; W4 owns platform-specific stable probe selectors/capabilities.

## Operator access

Recommended:

- Tailscale/WireGuard/SSH to the host,
- a private desktop/VNC channel reachable only through that tunnel,
- no public VNC port,
- no public DevTools port,
- profile/runtime directories mode `0700`,
- encrypted host/volume where practical.

`ops/bootstrap-runtime.sh` initializes owner-only runtime directories.

## Automated evidence

W3 tests prove:

- registry replay is idempotent;
- conflicting account configuration fails closed;
- profile reuse fails closed;
- profile path traversal fails closed;
- local profile lock excludes concurrent use;
- durable DB lease excludes concurrent identity use;
- session-health history is append-only at SQLite layer;
- auth-required and account mismatch fail the guard;
- real installed Chromium can retain a persistent cookie across a full browser restart using the same profile;
- real installed Chromium can drive the DOM-based identity/auth probe without network access;
- remote debugging is bound to localhost only.

Full repository suite: **42 passed / 0 failed** at W3 completion.

## Environment limitation found during local verification

The execution container applies an administrator policy that can block Chromium navigation to some local/data URLs with `ERR_BLOCKED_BY_ADMINISTRATOR`. This is an environment-specific navigation policy, not a Flerdvision state-machine failure. W3 therefore verifies persistence via CDP cookie storage and DOM probe mechanics without touching a real social site.

Real Instagram/TikTok/YouTube session bootstrap must be repeated on the intended browser-worker host before W4/W8 acceptance.
