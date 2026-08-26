# AGENTS.md — Flerdvision engineering contract

## Read order
1. `docs/00-NORTH-STAR.md`
2. `docs/01-ARCHITECTURE-GRAPH.md`
3. `docs/02-PORTS-AND-ADAPTERS.md`
4. `docs/03-STATE-MACHINES.md`
5. relevant ADRs

## Non-negotiable invariants
- Normal user-facing platform UIs are the publishing surface; do not introduce social publishing APIs unless an explicit architecture decision changes this.
- The current Google Drive folder layout is an **adapter concern**, never a domain schema.
- The current human/bot "posted" acknowledgement is an **adapter concern**, never proof by itself.
- A `PublishAttempt` is not a `VerifiedPublication`.
- On uncertain outcome, transition to `PUBLISH_UNCERTAIN`; never blindly retry an irreversible publish action. `SAFE_TO_RETRY` requires conservative negative evidence quorum or an explicit authorized human absence confirmation.
- Every irreversible action requires: durable intent, durable prepared attempt, persisted irreversible-boundary entry, idempotency key, target account allowlist, active publish gate, and pre-action evidence snapshot.
- Unknown UI, CAPTCHA, 2FA, account warnings, copyright/policy warnings, or identity ambiguity => fail closed and escalate.
- AI may diagnose and propose code patches; AI must not free-form click production accounts or bypass platform controls.
- Browser session data, cookies, credentials, customer media and evidence artifacts are never committed to git.
- One browser profile belongs to exactly one BrowserIdentity; concurrent profile/identity use is forbidden.
- A platform publisher must pass the exact-account `AccountIdentityGuard`; merely being logged in is insufficient.
- The W4 PREPARE_ONLY publisher must contain no working final publish action. Any later final action must pass through `DurableFinalActionService`, which persists irreversible-boundary entry before an invoker can act; no real social final-action invoker is wired before W8.
- Every reversible click must be runtime-checked against the configured final-action boundary.
- Real platform UI specs must be explicitly CALIBRATED; never promote placeholder/unverified selectors to a live account.
- Video bytes are immutable in the publishing system unless a future explicit content-processing contract says otherwise.
- Re-observing the same source object with a changed media fingerprint is a conflict and must fail closed; never silently replace accepted content.
- `Europe/Vienna` is the business scheduling timezone.
- Human incident acknowledgement/resolution never counts as publication verification.
- `PUBLISH_UNCERTAIN` cannot be bypassed by an Ops UI Resume action; only W5 reconciliation can open a retry path.
- Global/account/platform kill switches must gate due-work claim and be re-checked immediately before irreversible-boundary entry.
- Operations notifications use the durable outbox; do not call a bot transport as the source of truth.
- Ops UI stays private by default (`127.0.0.1`) and state-changing actions require authentication + CSRF protection.
- Production customer accounts are forbidden until all gates in `docs/06-GO-LIVE-GATES.md` are satisfied.

## Change discipline
- New external system => new adapter behind an existing/new port, not domain leakage.
- New state => update state machine, transition tests, graph docs, and incident semantics together.
- New irreversible behavior => ADR + tests + canary plan.
- Prefer deterministic rules before AI inference.
