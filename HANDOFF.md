# HANDOFF — current repository state

## Current phase
W2 — pluggable ingress/source acknowledgement **complete under local verification**. W3 is next.

## Implemented
- W0 architecture graph and reverse-trace model,
- domain data contracts and publication safety state machine,
- hard final-publish gate and verification skeleton,
- SQLite migration-backed durable control plane,
- append-only DB-enforced event log,
- durable publication-intent repository,
- idempotency conflict protection,
- Europe/Vienna scheduler with 09/11/15/17 targets, ±30 min windows, cap/spacing policy,
- no-catch-up missed-window guard,
- worker leases and expiry/reacquisition,
- restart recovery split at irreversible publish boundary,
- admin read model/CLI,
- W2 durable SourceObservation/ContentItem/SourceDisposition persistence,
- read-only recursive Google Drive discovery + pagination,
- configurable current creator/week/day interpreter,
- second metadata-driven interpreter proving ingress replacement,
- duplicate/mutated-source protection,
- noop/webhook/Drive-appProperties/composite disposition adapters,
- durable source acknowledgement semantics,
- 33 automated tests passing.

## Safety correction made in W1
`PUBLISH_UNCERTAIN -> READY` was removed. An uncertain irreversible outcome must reconcile through `VERIFYING` before any retry path exists.

## Known technical risk
The current isolated SQLite adapter uses Node 22.16 `node:sqlite`, which emits an ExperimentalWarning in the build environment. Close this driver/runtime decision before customer canary; it does not require a domain redesign. See `docs/10-W1-DURABLE-CONTROL-PLANE.md`.

## Intentionally not implemented yet
- real Google Drive credential/bootstrap and live folder scan,
- exact current bot/checkmark receiver integration,
- real Playwright platform adapters,
- browser-account profiles/sessions,
- final-publish capability on any real account.

These remain blocked by wave order.

## Next implementation order
W3 browser identities -> W4 PREPARE_ONLY adapters -> W5 verification -> W6 operations/bot integration.

## Safety
Do not enable customer publishing during W0–W8. Follow `docs/06-GO-LIVE-GATES.md`.
