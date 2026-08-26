# 13 — W4 platform UI PREPARE_ONLY

Status: **IMPLEMENTATION DONE — local/synthetic verification; real-platform calibration deferred to W8 test-account acceptance**.

## Purpose

W4 builds the reversible platform-UI path for Instagram Web, TikTok Web/Studio and YouTube Studio while making the irreversible final action physically unavailable.

The core flow is:

`PublicationIntent -> exact-account health guard -> MediaMaterializerPort -> PublicationPayloadResolverPort -> PlatformUiAdapterPort -> FINAL_ACTION_BOUNDARY -> prepared PublishAttempt`

No W4 adapter contains a final share/post/publish implementation.

## Implemented components

### Browser UI kernel
`BrowserDomUiDriver` supports replaceable semantic locators:
- CSS,
- visible text,
- role + accessible name,
- associated label.

It can:
- wait/assert visible,
- click reversible controls,
- fill text/contenteditable fields,
- set native file inputs through Chrome DevTools Protocol.

Every click is compared at runtime against the configured `finalActionBoundary`. If the candidate click resolves to the same DOM element as the final boundary, the driver refuses the action. This protects against a misconfigured UI spec accidentally placing the irreversible control in a prepare step.

### Chromium capabilities added
The W3 CDP runtime now additionally supports:
- `DOM.setFileInputFiles`,
- `Page.captureScreenshot`.

DevTools remains localhost-only.

### Media materialization
`MediaMaterializerPort` isolates source retrieval from browser automation.

Adapters:
- `LocalFileMediaMaterializer` for controlled local/test files,
- `GoogleDriveRestMediaMaterializer` for streamed Drive media download into a private cache.

The exact local file is SHA-256 hashed after materialization. The publishing system does not re-encode or mutate the video.

### Publication payload
`PublicationPayloadResolverPort` isolates caption/title/description/hashtags from the platform UI.

`StaticPublicationPayloadResolver` is the deterministic W4 implementation keyed by `copyVersionId`. Later SOP/copy generation can replace it without changing the platform adapter.

### Platform adapters
All three platform types use one declarative kernel:
- `InstagramWebPrepareAdapter`,
- `TikTokWebPrepareAdapter`,
- `YouTubeStudioPrepareAdapter`.

Account/platform UI details are `PlatformUiSpec` configuration rather than domain rules.

### Capability registry
SQLite migration 4 adds append-only per-account capability probes. A probe records the current UI's observed availability for capabilities such as:
- video upload,
- caption/title fields,
- Reel / Trial Reel / TikTok video / YouTube Short controls,
- final-action boundary.

Capability history cannot be updated or deleted in place.

### Evidence around prepare boundaries
`LocalPrepareArtifactSink` captures, under runtime-only private storage:
- PNG screenshot,
- HTML DOM snapshot,
- metadata JSON,
- action journal.

Canonical boundaries:
1. bootstrap,
2. media loaded,
3. fields/format prepared,
4. final-action boundary visible.

These artifacts are operational evidence and may contain account/customer information; they must never be committed to git.

### Hard final-action absence
`PrepareOnlyPlatformPublisher.invokeFinalAction()` always throws `PrepareOnlyFinalActionError`, even if passed a production context with an enabled publish gate. W4 therefore cannot publish by construction.

## Platform UI calibration contract

`config/platform-ui.example.json` deliberately contains `UNVERIFIED` placeholder specs.

Real execution requires a separate calibrated spec:
- `calibrationStatus = CALIBRATED`,
- `calibratedAt`,
- `calibratedBy`,
- no `__CALIBRATE__` placeholders.

The config loader refuses uncalibrated specs when `requireCalibrated=true`.

Validation:

```bash
npm run platform-ui -- validate config/platform-ui.example.json
npm run platform-ui -- validate path/to/deployment-specs.json --require-calibrated
```

Real Instagram/TikTok/YouTube selectors are intentionally **not guessed in this repository**. They must be calibrated against the private test-account browser sessions before W8 live E2E.

## Local automated evidence

At W4 completion:
- W4-specific tests: **12 passed / 0 failed**,
- full suite: **54 passed / 0 failed**,
- real installed Chromium exercises native file input, field filling, screenshots and final-boundary detection against synthetic DOM fixtures,
- Instagram Reel + Trial Reel prepare semantics tested,
- TikTok prepare semantics tested,
- YouTube Short prepare semantics tested,
- final button click remains absent,
- a deliberately unsafe config that points a prepare click at the final button is blocked,
- Drive media materializer transport/hash contract tested without external network dependency.

## Plan deviation

The original W4 exit text called for repeated *live* prepare-only runs. The user-defined rollout sequence later clarified that real E2E should use the user's private/test Instagram only after the codebase is complete enough for safe testing. Because no real account/session or calibrated selector set is configured in the build environment, real-platform UI calibration and repeated live prepare-only runs are moved to the W8 test-account acceptance campaign.

This does not weaken the W9 customer gate: customer canary remains blocked until the real W8 runs are green.
