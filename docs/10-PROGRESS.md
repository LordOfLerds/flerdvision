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
| W5 | Verification + uncertainty reconciliation | NEXT |
| W6 | Notifications + operations | NOT STARTED |
| W7 | AI repair engineering loop | NOT STARTED |
| W8 | Private/test-account E2E + failure campaign | NOT STARTED |
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

## Next wave
W5: durable PublishAttempt / VerificationEvidence / VerifiedPublication persistence, reconciliation rules for `PUBLISH_UNCERTAIN`, proof storage and deterministic retry eligibility.
