# HANDOFF — current repository state

## Current phase
W5 — verification/reconciliation **implemented under local/synthetic verification**. W6 operations/notifications is next; real platform selector/final-action calibration remains a W8 private/test-account gate.

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
- W3 durable SocialAccount/BrowserIdentity registry,
- migration 3 + append-only session-health evidence,
- filesystem + durable DB profile locking,
- persistent Chromium runtime with localhost-only DevTools,
- first-time browser registration/bootstrap CLI,
- generic session probe + exact account identity guard,
- real Chromium restart/persistent-cookie test and DOM health-probe test,
- W4 generic semantic DOM UI driver with native file-input and screenshot support,
- exact-byte media materialization + SHA-256 for local/Google Drive sources,
- deterministic copy payload resolver keyed by copyVersionId,
- declarative Instagram/TikTok/YouTube PREPARE_ONLY adapters,
- append-only per-account platform capability probes / migration 4,
- screenshot + DOM + metadata + action-journal prepare evidence,
- runtime final-button click guard and publisher with physically absent final action,
- calibrated platform UI spec contract and validation CLI.
- W5 migration 5 with durable PublishAttempt persistence,
- durable irreversible-boundary entry persisted before final-action invocation,
- append-only verification evidence and decision history,
- immutable one-publication-per-intent VerifiedPublication record,
- conservative positive verification quorum and negative retry quorum,
- PUBLISH_UNCERTAIN reconciliation service,
- restart recovery that marks both intent and persisted attempt uncertain,
- manual operator verifier for published/not-published evidence,
- declarative profile verifier that requires a known-ready profile surface before negative evidence,
- private verification screenshot/DOM/manual proof sink,
- 66 automated tests passing at W5 full-suite checkpoint.

## Safety correction made in W1
`PUBLISH_UNCERTAIN -> READY` was removed. An uncertain irreversible outcome must reconcile through `VERIFYING` before any retry path exists.

## Known technical risk
The current isolated SQLite adapter uses Node 22.16 `node:sqlite`, which emits an ExperimentalWarning in the build environment. Close this driver/runtime decision before customer canary; it does not require a domain redesign. See `docs/10-W1-DURABLE-CONTROL-PLANE.md`.

## Intentionally not implemented yet
- real Google Drive credential/bootstrap and live folder scan,
- exact current bot/checkmark receiver integration,
- calibrated real Instagram/TikTok/YouTube selectors and live prepare-only account run,
- current bot/notification operations UI (W6),
- AI repair engineering loop (W7),
- calibrated real final-action invoker and real private/test-account E2E (W8),
- final-publish capability on any customer account.

These remain blocked by wave order.

## Next implementation order
W6 operations/bot integration -> W7 AI repair -> W8 private/test-account real selector/final-action calibration + E2E.

## W3 environment note
The build container applies a Chromium administrator navigation policy to some local/data URLs. No real social site was accessed. W4 uses real installed Chromium against synthetic DOM fixtures for native file input, form fields, screenshots and final-boundary safety. Real social-session bootstrap and selector calibration remain W8 operator-host acceptance steps.

## Safety
Do not enable customer publishing during W0–W8. Follow `docs/06-GO-LIVE-GATES.md`.
