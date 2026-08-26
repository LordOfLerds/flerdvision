# Flerdvision implementation progress

This file is the repository-local progress source of truth. Update it at every implementation checkpoint.

## Wave status

| Wave | Scope | Status |
|---|---|---|
| W0 | Canonical model, graph, ports, safety states | DONE |
| W1 | Durable control plane | DONE — local verification |
| W2 | Pluggable ingress + source acknowledgement | NEXT |
| W3 | Browser identity subsystem | NOT STARTED |
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

## Current automated evidence

- TypeScript build: PASS
- Tests: **21 passed / 0 failed** at W1 completion
- Customer publishing: **physically not implemented**
- Real social account access: **not implemented**

## Plan changes discovered during W1

### Safety correction
W0 had allowed `PUBLISH_UNCERTAIN -> READY`. This contradicted the canonical invariant that uncertain irreversible outcomes must reconcile before retry. W1 removed that transition and added regression tests.

### Runtime-driver risk
`node:sqlite` works in the current Node 22.16 environment but emits `ExperimentalWarning`. The store is isolated behind a port so this can be replaced without changing domain/application code. Must be closed before W9.

## Next wave
W2: source ingestion/disposition with at least two interchangeable fixture schemas before a live Google Drive adapter is allowed to mutate anything.
