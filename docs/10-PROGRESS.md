# Flerdvision implementation progress

This file is the repository-local progress source of truth. Update it at every implementation checkpoint.

## Wave status

| Wave | Scope | Status |
|---|---|---|
| W0 | Canonical model, graph, ports, safety states | DONE |
| W1 | Durable control plane | DONE — local verification |
| W2 | Pluggable ingress + source acknowledgement | DONE — local verification |
| W3 | Browser identity subsystem | DONE — local verification |
| W4 | Platform adapters PREPARE_ONLY | DONE — local/synthetic verification; live calibration deferred to W8 |
| W5 | Verification + uncertainty reconciliation | DONE — local/synthetic verification |
| W6 | Notifications + operations | DONE — local/synthetic verification |
| W7 | AI repair engineering loop | DONE — local/synthetic verification; provider-specific invocation deferred to deployment/W8 |
| W8 | Private/test-account E2E + failure campaign | IN PROGRESS — engineering harness/local synthetic acceptance done; real private-account acceptance pending |
| W9 | Customer canary | BLOCKED until W0–W8 green |
| W10 | Metrics automation | NOT STARTED |

## W1 acceptance

- [x] SQLite schema + migration 1
- [x] WAL / full-sync durability configuration
- [x] append-only event log enforced by DB triggers
- [x] durable publication intent repository
- [x] stable idempotency-key replay
- [x] conflicting idempotency payload fails closed
- [x] schedule reservations
- [x] Europe/Vienna canonical slot policy
- [x] DST tests
- [x] daily cap
- [x] spacing policy
- [x] no catch-up burst after missed window
- [x] worker leases / ownership
- [x] lease expiry and reacquisition
- [x] restart recovery before irreversible boundary
- [x] restart uncertainty after irreversible boundary
- [x] admin read model + CLI
- [x] full test suite green

## W1 automated evidence

- TypeScript build: PASS
- Tests: **21 passed / 0 failed** at W1 completion
- Customer publishing: **physically not implemented**
- Real social account access: **not implemented**

## Plan changes discovered during W1

### Safety correction
W0 had allowed `PUBLISH_UNCERTAIN -> READY`. This contradicted the canonical invariant that uncertain irreversible outcomes must reconcile before retry. W1 removed that transition and added regression tests.

### Runtime-driver risk
`node:sqlite` works in the current Node 22.16 environment but emits `ExperimentalWarning`. The store is isolated behind a port so this can be replaced without changing domain/application code. Must be closed before W9.

## W2 acceptance

- [x] durable source observation store
- [x] durable content item store
- [x] durable source disposition record
- [x] migration 2 upgrades W1 databases in place
- [x] duplicate observation deduplication
- [x] changed source fingerprint fails closed
- [x] read-only recursive Google Drive adapter
- [x] Drive pagination
- [x] current creator/week/day path interpreter
- [x] second metadata-driven interpreter proving schema replacement
- [x] noop disposition adapter
- [x] generic idempotency-key webhook disposition adapter
- [x] optional Drive appProperties disposition adapter
- [x] composite disposition adapter
- [x] durable/idempotent source acknowledgement service
- [x] retry of blocked acknowledgement after temporary sink failure
- [x] admin views for sources/content/dispositions
- [x] full test suite green

## W2 automated evidence

- TypeScript build: PASS
- Tests: **33 passed / 0 failed** at W2 completion
- Real Google Drive credential: **not configured**
- Real Drive mutation: **not performed**
- Customer publishing: **physically not implemented**
- Real social account access: **not implemented**

## Plan changes discovered during W2

### Migration correction
The W1 migration function returned after detecting migration 1, which would have prevented future schema migrations. W2 changed migration execution to independent ordered checks and added a W1 -> W2 upgrade regression test.

### Source immutability guard
A Drive/external object that changes media fingerprint after first observation is now a conflict, not an update. This is stricter than the original W2 checklist and prevents silently publishing edited source media under an existing identity.

### Exact current bot contract remains intentionally open
A generic webhook disposition adapter and optional Drive appProperties adapter exist, but the current human/bot checkmark behavior is not guessed. Exact integration moves to W6 once the receiver semantics are known.

### Week-date semantics remain explicit
The known Drive screenshots do not establish the week-folder naming convention. The interpreter therefore accepts explicit business date/week start configuration and does not guess based on current date.

## W3 acceptance

- [x] durable social-account registry
- [x] one persistent BrowserIdentity per account
- [x] unique browser profile key per identity
- [x] normalized exact expected-handle contract
- [x] migration 3 upgrades existing databases in place
- [x] append-only session-health history
- [x] profile-path traversal guard
- [x] local filesystem profile lock
- [x] durable DB lease for cross-process identity exclusion
- [x] headed/headless Chromium runtime adapter using persistent user-data-dir
- [x] Chromium DevTools bound to localhost only
- [x] first-time registration/bootstrap CLI
- [x] generic configurable session probe
- [x] account identity guard
- [x] auth-required/challenge/mismatch health states
- [x] real Chromium persistent-cookie restart test
- [x] real Chromium DOM identity/auth probe test
- [x] no upload/final-publish method exists in W3 subsystem

## W3 automated evidence

- TypeScript build: PASS
- W3-specific tests: **9 passed / 0 failed**
- Full suite: **42 passed / 0 failed**
- Real installed Chromium process/profile persistence: PASS
- Real social-site navigation: **not performed**
- Customer publishing: **physically not implemented**

## Plan changes discovered during W3

### Browser navigation policy in build container
The container Chromium can return `ERR_BLOCKED_BY_ADMINISTRATOR` for some local/data navigation. W3 therefore verifies real process/profile persistence through CDP cookie storage and verifies DOM probe mechanics without network access. Real social-site bootstrap must be repeated on the intended browser-worker host.

### Dual profile locking added
The plan originally called for profile isolation. W3 strengthened this to two layers: a local filesystem lock plus a durable DB lease keyed by browser identity. This prevents concurrent identity use across separate local lock roots/processes.

### Platform-specific identity probes remain W4 adapters
W3 implements the generic health/guard contract and DOM probe. Stable Instagram/TikTok/YouTube selectors and capability checks belong to W4 because they are platform UI knowledge, not identity-domain rules.

### W3 runtime uses Chromium CDP behind a port
The build environment could not reliably fetch new npm dependencies during W3, while system Chromium was available. W3 therefore implements persistent-profile/bootstrap mechanics with a small localhost-only CDP adapter. This is explicitly replaceable; W4 can add Playwright behind the browser/platform adapter seams without changing identity semantics.

## W4 acceptance

- [x] generic semantic DOM UI driver
- [x] native browser file-input upload primitive
- [x] browser screenshot primitive
- [x] exact-byte SHA-256 media materialization
- [x] local-file media adapter
- [x] streamed Google Drive media adapter
- [x] deterministic copy-version payload resolver
- [x] Instagram Web prepare adapter
- [x] Instagram Trial Reel prepare path in synthetic fixture
- [x] TikTok Web prepare adapter
- [x] YouTube Studio prepare adapter
- [x] append-only per-account capability probes / migration 4
- [x] screenshot + DOM + metadata + action journal boundary artifacts
- [x] hard final-action absence in W4 publisher
- [x] runtime protection against misconfigured prepare click resolving to final button
- [x] calibrated UI-spec contract; unverified specs rejected for real execution
- [x] full local/synthetic test suite green
- [ ] real Instagram/TikTok/YouTube selector calibration — intentionally deferred to W8 private/test-account acceptance


## W4 automated evidence

- TypeScript build: PASS
- W4-specific tests: **12 passed / 0 failed**
- Full suite: **54 passed / 0 failed**
- Real installed Chromium native file input / form / screenshot execution: PASS against synthetic fixture DOM
- Google Drive media download transport + SHA-256 materialization contract: PASS with isolated transport test
- Misconfigured prepare click resolving to final-action button: BLOCKED
- W1 database -> current migration 4 path: PASS
- Real social-site navigation/selectors: **not performed**
- Final publish implementation: **physically absent in W4 publisher**

## W4 plan change
The original W4 exit criterion mentioned live prepare-only runs. Real account/browser calibration is intentionally deferred to W8 because the rollout requirement is to finish and harden the code before touching the user's private test account. W9 remains blocked until those real W8 runs pass.

## W5 acceptance

- [x] migration 5 for PublishAttempt / VerificationEvidence / VerificationDecision / VerifiedPublication
- [x] durable irreversible-boundary entry stored before final invocation
- [x] append-only verification evidence
- [x] append-only verification decisions
- [x] one immutable VerifiedPublication per intent
- [x] receipt + profile positive verification quorum
- [x] positive incomplete signals block automatic retry
- [x] conservative multi-check negative retry quorum
- [x] manual operator published / not-published verifier
- [x] PUBLISH_UNCERTAIN reconciliation through VERIFYING
- [x] SAFE_TO_RETRY lands in RETRY_WAIT, never directly READY
- [x] restart after durable boundary marks persisted attempt uncertain
- [x] declarative profile verifier requires profile-ready proof before negative evidence
- [x] private screenshot/DOM/manual verification artifact sink
- [x] full suite green

## W5 automated evidence

- TypeScript build: PASS
- W5-specific tests: **16 passed / 0 failed**
- Full suite: **70 passed / 0 failed**
- Real installed Chromium profile positive/negative verification fixture: PASS
- Simulated post-click exception: one final invocation only; second invocation blocked
- Hard-restart after irreversible boundary: intent + attempt become uncertain
- Real social final-action invocation: **not wired**
- Customer publishing: **blocked**

## W5 plan changes

### Boundary timestamp split
W5 distinguishes durable `irreversibleBoundaryEnteredAt` from `finalActionInvokedAt`. The first is persisted before the UI action; this intentionally creates false uncertainty rather than duplicate-post risk if the process dies between the durable write and the click.

### Negative evidence is stronger than simple absence
A missing post selector is not negative proof unless the profile surface first reaches a configured known-ready state. Default retry policy requires three negative observations over ten minutes and at least ten minutes after boundary entry; an incomplete positive signal always blocks automatic retry.

### Final UI action remains W8-calibrated
W5 implements the durable final-action lifecycle and invoker port, but no real Instagram/TikTok/YouTube final-action invoker is wired. Real selectors/action are calibrated only on the private/test account in W8.

## W6 acceptance

- [x] migration 6 for incidents, human actions, kill switches and notification outbox
- [x] deterministic incident projector from durable runtime state
- [x] incident fingerprint dedupe / reopen semantics
- [x] append-only human operator action history
- [x] global/account/platform kill switches
- [x] kill switch checked before due-work claim
- [x] kill switch checked before irreversible publish boundary
- [x] human resume requires healthy browser identity and still-valid original window
- [x] PUBLISH_UNCERTAIN cannot be bypassed by human Resume
- [x] explicit operator Waive action with reason
- [x] durable notification outbox with dedupe key and retry metadata
- [x] generic webhook/current-bot notification adapter
- [x] 08:30 readiness summary in Europe/Vienna
- [x] 17:30 completion/incomplete summary in Europe/Vienna
- [x] minimal localhost-only Ops UI with Basic auth + CSRF
- [x] deterministic recovery guidance in Ops UI
- [x] optional protected browser-session link seam
- [x] full suite green

## W6 automated evidence

- TypeScript build: PASS
- W6-specific tests: **14 passed / 0 failed**
- Full suite: **84 passed / 0 failed** at W6 checkpoint
- Notification webhook contract/idempotency-header test: PASS
- Local HTTP Ops UI auth + CSRF action test: PASS
- Kill switch blocks worker claim: PASS
- Kill switch blocks irreversible boundary entry: PASS
- Reopened incident generates a new occurrence notification without duplicate spam: PASS
- Real customer bot receiver: **not configured**
- Real social final-action invocation: **not wired**
- Customer publishing: **blocked**

## W6 plan changes

### Incident recurrence semantics hardened
A resolved incident that later recurs reopens the same incident identity, increments the occurrence counter and produces a new deduplicated notification occurrence. Repeated polling of the same observation does not spam.

### Missed-window projection survives guard ordering
W6 reads the durable BLOCKED transition reason as well as currently missed SCHEDULED reservations, so a missed-window incident is still visible if the W1 MissedWindowGuard ran before the operations projector.

### Kill-switch semantics made explicit
A kill switch blocks new work claims and is re-checked immediately before durable irreversible-boundary entry. It does not claim to cancel an action that already crossed that boundary.

### Bot remains an adapter
The exact current bot/checkmark transport is still intentionally not guessed. W6 provides a tested generic webhook bridge with idempotency keys; deployment can plug the real receiver into that port without changing operations or publish semantics.

## W7 acceptance

- [x] migration 7 repair/audit persistence
- [x] append-only sanitized evidence bundles
- [x] text/DOM/log redaction and evidence-root confinement
- [x] raw binary screenshot/trace omission from AI bundles by default
- [x] structured AI diagnosis/proposal ports
- [x] runtime validation of untrusted AI JSON
- [x] deterministic repair policy
- [x] hard prohibition for PUBLISH_UNCERTAIN automated repair/retry
- [x] human-only auth/challenge/identity/policy/copyright/account-warning classes
- [x] AI child-process environment allowlist (no inherited social secrets)
- [x] patch path/token/size/file-count/delete/rename/binary guards
- [x] regression-test requirement
- [x] isolated Git branch/worktree patch flow
- [x] fixed repository-owned regression/full-suite commands; AI commands ignored
- [x] prepare-only replay gate contract
- [x] production promotion structurally false in W7
- [x] repair inspection/bundle/prepare CLI
- [x] full test suite green

## W7 automated evidence

- TypeScript build: PASS
- W7-specific tests: **15 passed / 0 failed**
- Full suite: **99 passed / 0 failed** at W7 completion checkpoint
- Real external Claude/Codex provider invocation: **not performed; no provider CLI is installed in the build environment**
- Real social account access: **not performed**
- Production promotion from AI repair: **physically unsupported by W7 report contract**

## W7 plan changes

### Binary screenshot evidence is stricter than planned
The original design said “redacted screenshot”. W7 does not claim safe pixel-level redaction without a dedicated sanitizer. Raw screenshots/traces remain local and are excluded from model input by default. Safe text/DOM/log evidence is still supplied.

### AI provider is an adapter, not a hidden dependency
The repository implements a structured command-wrapper adapter and does not assume Claude/Codex is installed. Deployment can supply a compatible provider wrapper without granting it browser profiles/social credentials.

### AI-generated commands are never executed
The model may return requested commands for audit/explanation, but test execution is controlled exclusively by fixed repository configuration.


## W8 engineering-harness acceptance

- [x] migration 8 for private E2E runs, append-only gate history and one-shot publish permits
- [x] private E2E run/gate domain model
- [x] host preflight with private runtime-directory checks and publish-disabled default
- [x] strict zero-viewer privacy attestation policy
- [x] one-shot permit bound to E2E run + intent + account + release SHA
- [x] permit TTL 30–600 seconds and single-consumption enforcement
- [x] minimum three successful PREPARE_ONLY replays before permit issuance
- [x] shared `PlatformPreparationCoordinator` extracted from W4 reversible preparation
- [x] W4 PREPARE_ONLY still closes/releases its session and has no final-action method
- [x] W8 retained `PreparedPlatformSession` preserves the exact browser state at final-action boundary
- [x] private final-action controller consumes one-shot permit then delegates to W5 durable boundary
- [x] retained-session invoker clicks the calibrated final element only after W5 boundary persistence
- [x] real installed Chromium retained-session final-click proof against synthetic UI
- [x] AI-provider activation modes/preflight separated from social publishing
- [x] W8 operator CLI for host preflight/run/status/privacy attestation/permit
- [x] ADR for retained-session/one-shot irreversible private E2E path
- [ ] intended private browser-worker host acceptance
- [ ] dedicated private test-account human login + 2FA
- [ ] exact real-account identity health proof
- [ ] real Instagram UI/fingerprint/selectors calibrated
- [ ] three real PREPARE_ONLY passes
- [ ] zero-viewer privacy facts verified on real test account
- [ ] exactly one permitted real private publish
- [ ] real W5 profile verification
- [ ] cleanup/delete and absence verification
- [ ] real-host crash/network/session failure campaign

## W8 automated evidence (engineering harness)

- TypeScript build: PASS
- W8-specific tests: **6 passed / 0 failed**
- Full suite: **105 passed / 0 failed** at current W8 engineering checkpoint
- Real installed Chromium retained-session final click: PASS against synthetic fixture UI
- Durable W5 boundary before retained-session click: PASS
- W4 PREPARE_ONLY regression after shared preparation refactor: PASS in full suite
- Real social-account navigation/login: **not performed yet**
- Real private/test-account publication: **not performed yet**
- Customer publishing: **still blocked**

## W8 plan changes / discoveries

### Same-session final action
W4 correctly closed the browser after PREPARE_ONLY. W8 discovered that a real final action must occur on the exact already-prepared browser state after W5 persists the irreversible boundary; rebuilding the upload after boundary entry would create a second ambiguous path. Preparation was therefore extracted into a shared coordinator with a retained-session lifecycle only for W8.

### One-shot human permit added
A live private E2E action is now gated by a short-lived one-use token bound to run, intent, account and release SHA. The DB stores only its SHA-256 hash. This is stricter than a global `ALLOW_FINAL_PUBLISH=true` flag and prevents an old test authorization being reused.

### AI subscription and service modes separated
W8 adds explicit provider activation modes. Subscription CLI authentication is suitable for operator-led pilot work; unattended shared production is modeled separately through dedicated provider/API credentials. The AI provider remains optional and cannot block deterministic publishing/verification/operations.

## Current next gate
Complete W8 on the intended private test host. W9 customer canary remains blocked until every real W8 acceptance item above is green.

### 2026-08-26 — W8 multi-platform extension
- Demo Google Drive E2E tree created (test-only, no customer content).
- Mandatory campaign matrix added: Instagram normal Reel + Trial Reel; TikTok Only you / Followers / Friends / Everyone.
- Secret-live eligibility is fail-closed: IG normal Reel on private zero-follower account and TikTok Only you only.
- Real account execution remains pending; code/harness is not equivalent to a completed W8 live acceptance.
