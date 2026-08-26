# Flerdvision

## Current implementation status

- W0 canonical architecture: **done**
- W1 durable control plane: **done under local verification**
- W2 pluggable ingress/disposition: **done under local verification**
- W3 browser identity subsystem: **done under local verification**
- W4 PREPARE_ONLY platform UI kernel/adapters: **implemented under local/synthetic verification**
- W5 verification/reconciliation: **done under local/synthetic verification**
- W6 operations/notifications: **done under local/synthetic verification**
- W7 AI repair engineering loop: **done under local/synthetic verification**
- Automated tests: **99 passed / 0 failed** at W7 checkpoint
- Real platform selector/final-action calibration and private publish E2E: **W8 next**
- Customer publishing: **not wired and intentionally blocked**

Architecture-first repository for a **UI-native social publishing system** using normal user logins. Social platform APIs are intentionally outside the publishing path.

## Safety status

**NOT LIVE.** Final publishing is disabled by default. The repository is deliberately structured so that content arrival, routing, publication, verification and notifications are independent ports/adapters.

## Core invariant

A UI click is never treated as a successful publication. The durable chain is:

`SourceObservation -> ContentItem -> PublicationIntent -> PublishAttempt -> VerificationEvidence -> VerifiedPublication`

Every node is traceable backward to its source and forward to its targets.

## Start here

1. `docs/00-NORTH-STAR.md`
2. `docs/01-ARCHITECTURE-GRAPH.md`
3. `docs/02-PORTS-AND-ADAPTERS.md`
4. `docs/03-STATE-MACHINES.md`
5. `docs/04-FIRST-TIME-SETUP.md`
6. `docs/05-TEST-STRATEGY.md`
7. `docs/06-GO-LIVE-GATES.md`
8. `docs/07-INCIDENTS-AND-AI-REPAIR.md`
9. `docs/08-IMPLEMENTATION-WAVES.md`
10. `docs/12-W3-BROWSER-IDENTITY.md`
11. `docs/13-W4-PREPARE-ONLY.md`
12. `docs/14-W5-VERIFICATION-AND-RECONCILIATION.md`
13. `docs/15-W6-OPERATIONS-AND-NOTIFICATIONS.md`
14. `docs/16-W7-AI-REPAIR.md`

## Current code

The repository now contains the durable control plane, replaceable ingress/disposition adapters, persistent browser identities, a PREPARE_ONLY platform UI kernel, W5 publish-attempt/evidence/reconciliation semantics, W6 incidents/notifications/human recovery/kill switches, and the W7 sanitized AI-assisted repair engineering loop. The W4 publisher still contains no irreversible final social action; W5 adds the guarded lifecycle contract and W6 gates it operationally, but no real social final-action invoker is wired. Real platform selectors remain explicitly uncalibrated until W8 private/test-account E2E.

```bash
npm run check
```

## Handoff

`AGENTS.md` and `CLAUDE.md` define the non-negotiable invariants for any coding agent. Architecture decisions live under `docs/adr/`.
