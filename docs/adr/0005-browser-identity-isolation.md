# ADR 0005 — One social account, one persistent browser identity

Status: accepted in W3.

## Context

Flerdvision publishes through normal user-facing platform UIs. Authentication therefore lives in a browser profile/session rather than a social publishing API credential. Reusing profiles across accounts or opening one profile concurrently creates a high-risk failure mode: content can be posted under the wrong account or Chromium profile state can be corrupted.

## Decision

1. Every configured `SocialAccount` has at most one active `BrowserIdentity` in the MVP.
2. Every `BrowserIdentity` owns one unique persistent `profileKey` below the configured profile root.
3. Profile/session bytes are runtime secrets and never enter git.
4. Concurrent use is prevented by both a local filesystem lock and a durable control-plane lease.
5. Session health is append-only evidence.
6. A later platform publisher must pass `AccountIdentityGuard`; being authenticated is insufficient unless the exact expected account identity is observed.
7. Chromium DevTools binds to localhost only.
8. Human login and 2FA remain normal operator actions; credentials are not automated or persisted in source code.

## Runtime adapter

W3 includes a dependency-free Chromium CDP runtime for persistent profile bootstrap and session-health mechanics. This is an adapter, not a domain decision. W4 may add a Playwright implementation of the same browser/platform seams without changing SocialAccount, BrowserIdentity, session-health or guard semantics.

## Consequences

Positive:
- wrong-account risk is constrained structurally,
- sessions survive browser/process restart,
- profile ownership can be reasoned about and audited,
- W4 platform UI code remains replaceable.

Costs:
- first-time setup requires a human login per account,
- profile storage must be treated like credentials,
- UI/session probes require maintenance when platform UIs change.
