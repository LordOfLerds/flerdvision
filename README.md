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
- W8 private E2E safety harness: **implemented under local/synthetic verification; real private-account acceptance pending**
- Automated tests: **105 passed / 0 failed** at current W8 engineering checkpoint
- Real platform selector/final-action calibration and private publish E2E: **W8 real-host gate next**
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
15. `docs/17-W8-PRIVATE-E2E.md`
16. `docs/18-AI-PROVIDER-ACTIVATION.md`
17. `docs/adr/0006-private-e2e-retained-session-final-action.md`

## Current code

The repository now contains the durable control plane, replaceable ingress/disposition adapters, persistent browser identities, the PREPARE_ONLY platform UI kernel, W5 publish-attempt/evidence/reconciliation semantics, W6 incidents/notifications/human recovery/kill switches, the W7 sanitized AI-assisted repair engineering loop, and a W8 private-E2E safety harness. W4 remains physically non-publishing. W8 can retain the exact prepared browser session and exposes a one-shot test-only final-action path only after W8 gates and W5 durable-boundary persistence. Real platform selectors, login, private publish verification, cleanup and failure injection remain pending on the intended private test host; customer publishing remains blocked.

```bash
npm run check
```

## Handoff

`AGENTS.md` and `CLAUDE.md` define the non-negotiable invariants for any coding agent. Architecture decisions live under `docs/adr/`.
