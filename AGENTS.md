# AGENTS.md — Flerdvision engineering contract

## Read order
1. `docs/00-NORTH-STAR.md`
2. `docs/22-ENGINEERING-EXECUTION-PROTOCOL.md`
3. **On `recovery/operator-product-v1`: `docs/25-PRODUCT-RECOVERY-GRAPH.md` before choosing, expanding or implementing work. It is the binding product/work-package graph for this branch.**
4. **On `rebuild/headless-agentic-v1` while finish issues #4–#7 are open: `docs/FINISH-LINE.md`.** The old audit issue #2 is superseded and is not a current backlog.
5. `docs/01-ARCHITECTURE-GRAPH.md`
6. `docs/02-PORTS-AND-ADAPTERS.md`
7. `docs/03-STATE-MACHINES.md`
8. relevant ADRs

On the recovery branch, work follows the WP graph and exit gates in `docs/25-PRODUCT-RECOVERY-GRAPH.md`. Do not fall back to the old #4 -> #5 -> #6 -> #7 finish-only prioritization there. Existing architecture and safety invariants remain authoritative unless the recovery graph explicitly changes a non-safety product/process assumption.

## Non-negotiable invariants
- Normal user-facing platform UIs are the publishing surface; do not introduce social publishing APIs unless an explicit architecture decision changes this.
- The current Google Drive folder layout is an **adapter concern**, never a domain schema.
- The current human/bot "posted" acknowledgement is an **adapter concern**, never proof by itself.
- A `PublishAttempt` is not a `VerifiedPublication`.
- On uncertain outcome, transition to `PUBLISH_UNCERTAIN`; never blindly retry an irreversible publish action. `SAFE_TO_RETRY` requires conservative negative evidence quorum or an explicit authorized human absence confirmation.
- Every irreversible action requires: durable intent, durable prepared attempt, persisted irreversible-boundary entry, idempotency key, target account allowlist, active publish gate, and pre-action evidence snapshot.
- Unknown UI, CAPTCHA, 2FA, account warnings, copyright/policy warnings, or identity ambiguity => fail closed and escalate.
- AI may diagnose and propose code patches; AI must not free-form click production accounts or bypass platform controls.
- AI receives only sanitized evidence bundles; raw browser profiles/social credentials and raw binary screenshots/traces are not model input by default.
- Treat AI JSON/diffs as untrusted data: validate schema, repair policy, patch scope and actual Git changed files before execution.
- `PUBLISH_UNCERTAIN`, auth/challenge/identity and policy/copyright/account-warning incidents can never be automated into a repair/retry by AI.
- AI-proposed shell/test commands are never executed; only fixed repository-owned test commands may run.
- AI repair patches run only in isolated repair branches/worktrees and cannot modify safety/verification/reconciliation/kill-switch/storage/runtime-secret surfaces through the automatic path.
- Automatic repair may create gated candidates only; it can never self-promote code directly to Brother Production.
- Acceptance-only final-action authorization must be bounded to the intended run/intent/account/release and must never become a generic bypass for production safety gates.
- A real final action must operate on the exact retained prepared browser session; do not rebuild the upload after irreversible-boundary entry.
- `DurableFinalActionService` must persist irreversible-boundary entry before any retained-session final click.
- A final click is action evidence only and never creates `VerifiedPublication`; verification/reconciliation remains authoritative.
- Never claim a zero-viewer/private E2E unless private account + zero approved followers + contacts sync off + cross-posting off + test-only media are explicitly attested.
- Browser session data, cookies, credentials, customer media and evidence artifacts are never committed to git.
- One browser profile belongs to exactly one BrowserIdentity; concurrent profile/identity use is forbidden.
- A platform publisher must pass the exact-account `AccountIdentityGuard`; merely being logged in is insufficient.
- PREPARE_ONLY publisher paths must contain no working ungated final publish action. Any final action must pass through `DurableFinalActionService`, which persists irreversible-boundary entry before an invoker can act.
- Every reversible click must be runtime-checked against the configured final-action boundary.
- Real platform UI specs must be explicitly CALIBRATED; never promote placeholder/unverified selectors to a live account.
- Video bytes are immutable in the publishing system unless a future explicit content-processing contract says otherwise.
- Re-observing the same source object with a changed media fingerprint is a conflict and must fail closed; never silently replace accepted content.
- `Europe/Vienna` is the business scheduling timezone.
- Human incident acknowledgement/resolution never counts as publication verification.
- `PUBLISH_UNCERTAIN` cannot be bypassed by an Ops UI Resume action; only reconciliation can open a retry path.
- Global/account/platform kill switches must gate due-work claim and be re-checked immediately before irreversible-boundary entry.
- Operations notifications use the durable outbox; do not call a bot transport as the source of truth.
- Any private Ops/remote-browser surface stays private/authenticated by default; state-changing actions require appropriate authentication and request protection.
- Brother Production/customer accounts are forbidden until the recovery release gates and `docs/06-GO-LIVE-GATES.md` are satisfied on one exact SHA.
- Each installation/workspace owns a physically separate SQLite DB, browser-profile root and evidence root; do not introduce cross-installation shared social state.
- Recovery promotion order is release-SHA strict: `CI -> LUCA_ACCEPTANCE -> BROTHER_CANARY -> BROTHER_PRODUCTION`; do not relabel build-container tests as a real-host or real-surface pass.
- Self-service Test Lab may execute only repository-defined allowlisted commands; never execute a user/AI-provided shell string.
- Installation defaults must not silently authorize final publishing. Acceptance/production final publishing requires the explicit runtime gates defined by the product and release process; no generic secret-live bypass exists.

## Change discipline
- `docs/22-ENGINEERING-EXECUTION-PROTOCOL.md` is binding for repair/build work in this repository.
- On `recovery/operator-product-v1`, `docs/25-PRODUCT-RECOVERY-GRAPH.md` is additionally binding: every slice must name its WP, changed forward/reverse graph edges, qualification impact, safety impact and delete impact.
- On the historical finish branch only, `docs/FINISH-LINE.md` remains the finish-mode prioritization document.
- New external system => new adapter behind an existing/new port, not domain leakage.
- New state => update state machine, transition tests, graph docs, and incident semantics together.
- New irreversible behavior => ADR + tests + canary plan.
- Prefer deterministic rules before AI inference.
- Prefer small vertical slices and authoritative GitHub safepoints over broad session-local work.
- Do not report a milestone as green unless the required evidence level is actually present.
