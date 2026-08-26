# Flerdvision implementation progress

This file is the repository-local progress source of truth. Update it at every implementation checkpoint.

## Wave status

| Wave | Scope | Status |
|---|---|---|
| W0 | Canonical model, graph, ports, safety states | DONE |
| W1 | Durable control plane | DONE — local verification |
| W2 | Pluggable ingress + source acknowledgement | DONE — local verification |
| W3 | Browser identity subsystem | NEXT |
| W4 | Platform adapters PREPARE_ONLY | NOT STARTED |
| W5 | Verification + uncertainty reconciliation | NOT STARTED |
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

## Next wave
W3: persistent browser identities, headed first-time login/bootstrap, session health and exact account identity guards. No final publishing.
