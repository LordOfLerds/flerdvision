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
- On uncertain outcome, transition to `PUBLISH_UNCERTAIN`; never blindly retry an irreversible publish action.
- Every irreversible action requires: durable intent, idempotency key, target account allowlist, active publish gate, and pre-action evidence snapshot.
- Unknown UI, CAPTCHA, 2FA, account warnings, copyright/policy warnings, or identity ambiguity => fail closed and escalate.
- AI may diagnose and propose code patches; AI must not free-form click production accounts or bypass platform controls.
- Browser session data, cookies, credentials, customer media and evidence artifacts are never committed to git.
- Video bytes are immutable in the publishing system unless a future explicit content-processing contract says otherwise.
- `Europe/Vienna` is the business scheduling timezone.
- Production customer accounts are forbidden until all gates in `docs/06-GO-LIVE-GATES.md` are satisfied.

## Change discipline
- New external system => new adapter behind an existing/new port, not domain leakage.
- New state => update state machine, transition tests, graph docs, and incident semantics together.
- New irreversible behavior => ADR + tests + canary plan.
- Prefer deterministic rules before AI inference.
