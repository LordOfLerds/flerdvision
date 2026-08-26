# HANDOFF — current repository state

## Current phase
W8 — private/test-account E2E **engineering harness implemented and locally/synthetically verified**. Real private test-host/account calibration, one permitted publish, verification, cleanup and failure campaign remain the current gate. W9 customer canary is still blocked.

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
- W6 migration 6 with durable incidents, human actions, kill switches and notification outbox,
- deterministic incident projector with dedupe/reopen semantics,
- global/account/platform kill-switch gate at work claim + irreversible boundary,
- human recovery service with safe Resume/Waive constraints,
- generic current-bot webhook notification adapter with idempotency key,
- 08:30 readiness + 17:30 completion operations cadence in Europe/Vienna,
- localhost-only Basic-auth + CSRF Ops UI with recovery guidance,
- 84 automated tests passing at W6 full-suite checkpoint,
- W7 sanitized incident evidence bundles + migration 7,
- runtime AI diagnosis/proposal schema validation,
- deterministic repair policy that prohibits uncertain-publish/auth/identity/policy automation,
- isolated Git repair worktrees/branches + patch scope guards,
- fixed regression/full-suite gates + PREPARE_ONLY replay contract,
- command AI adapter with restricted environment and no inherited social secrets,
- 99 automated tests passing at W7 full-suite checkpoint,
- W8 migration 8 with private E2E runs, append-only gate results and one-shot publish permits,
- strict zero-viewer privacy attestation contract,
- one-shot permit bound to run + intent + account + release SHA with TTL/single-consumption enforcement,
- shared platform preparation coordinator while preserving non-publishing W4 behavior,
- retained prepared browser session for the W8-only final-action path,
- W5 durable-boundary-before-click integration on the same retained session,
- real installed Chromium synthetic final-click proof,
- W8 host/provider preflight and operator CLI,
- explicit AI provider modes separating subscription CLI pilot use from API/service production use,
- 105 automated tests passing at current W8 engineering checkpoint.

## Safety correction made in W1
`PUBLISH_UNCERTAIN -> READY` was removed. An uncertain irreversible outcome must reconcile through `VERIFYING` before any retry path exists.

## Known technical risk
The current isolated SQLite adapter uses Node 22.16 `node:sqlite`, which emits an ExperimentalWarning in the build environment. Close this driver/runtime decision before customer canary; it does not require a domain redesign. See `docs/10-W1-DURABLE-CONTROL-PLANE.md`.

## Intentionally not implemented yet
- real Google Drive credential/bootstrap and live folder scan,
- exact production bot/checkmark receiver URL/auth configuration,
- calibrated real Instagram/TikTok/YouTube selectors and live prepare-only account run,
- real private/test-account login/UI calibration, one permitted publish, verification, cleanup and failure campaign (remaining W8 acceptance),
- final-publish capability on any customer account.

These remain blocked by wave order.

## Next implementation order
Finish W8 on the intended private test host: human login/2FA -> exact identity -> real UI calibration -> three PREPARE_ONLY passes -> privacy attestation -> one short-lived permit -> one private publish -> W5 verification -> cleanup -> real-host failure campaign. Do not start W9 before all these gates are green.

## W3 environment note
The build container applies a Chromium administrator navigation policy to some local/data URLs. No real social site was accessed. W4 uses real installed Chromium against synthetic DOM fixtures for native file input, form fields, screenshots and final-boundary safety. Real social-session bootstrap and selector calibration remain W8 operator-host acceptance steps.

## Safety
Do not enable customer publishing during W0–W8. Follow `docs/06-GO-LIVE-GATES.md`.

## W8 multi-platform campaign extension — 2026-08-26
- Real demo Drive root created outside Git: `Flerdvision_PRIVATE_E2E_DEMO`.
- Canonical current-schema path: `01_TestCreator/2026-KW35/03_Mittwoch/`.
- Mandatory W8 coverage now includes Instagram normal Reel, Instagram Trial Reel, and TikTok Only you / Followers / Friends / Everyone.
- Zero-viewer live cases: Instagram normal Reel on a private zero-follower test account; TikTok `Only you`.
- Trial Reel is prepare-only in the zero-viewer campaign because its purpose is non-follower distribution.
- W8 completion requires all mandatory prepare-only cases + both secret-live verified cases + cleanup + failure-injection campaign.
