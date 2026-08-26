## Current implementation status

- W0 canonical architecture: **done**
- W1 durable control plane: **done under local verification**
- W2 pluggable ingress/disposition: **done under local verification**
- Automated tests: **33 passed / 0 failed**
- W3 browser identity subsystem: **next**
- Real social-account publishing: **not implemented and intentionally blocked**

See `docs/10-PROGRESS.md`, `docs/10-W1-DURABLE-CONTROL-PLANE.md`, and `docs/11-W2-PLUGGABLE-INGRESS.md`.

# Flerdvision

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

## Current code

The repository now contains the durable control plane plus replaceable ingress/disposition adapters. Google Drive discovery code is read-only by default; optional acknowledgement writers are not wired. Social platform/browser implementations are still absent, so no irreversible social action is currently possible.

```bash
npm run check
```

## Handoff

`AGENTS.md` and `CLAUDE.md` define the non-negotiable invariants for any coding agent. Architecture decisions live under `docs/adr/`.
