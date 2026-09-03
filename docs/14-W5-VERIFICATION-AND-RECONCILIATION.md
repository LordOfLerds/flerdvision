# W5 — Verification and uncertainty reconciliation

Status: **DONE under local/synthetic verification. Real social selectors/final action remain W8 acceptance work.**

## Core ordering

The irreversible publish boundary is deliberately conservative:

`PREPARING -> durable boundary record -> PUBLISHING -> final UI action -> VERIFYING`

The durable boundary record is written **before** the final UI action. A hard crash after that record is therefore treated as potentially published even if the click may never have reached the platform. False uncertainty is acceptable; accidental duplicate publishing is not.

## Durable graph

`PublicationIntent -> PublishAttempt -> VerificationEvidence -> VerificationDecision -> VerifiedPublication`

- Publish attempts keep release SHA, browser identity, media SHA-256 and preparation artifacts.
- Verification evidence is append-only.
- Verification decisions are append-only.
- A publication is immutable and unique per intent.
- Evidence/artifact paths are runtime references; browser/session secrets are not stored in Git.

## Positive verification quorum

Automatic VERIFIED currently requires:

1. positive profile evidence (`profile_permalink` or `profile_media_match`), and
2. an independent supporting signal (`ui_receipt` or authorized `manual_confirmation`).

A positive signal that does not yet reach quorum keeps the intent uncertain. It explicitly blocks automatic retry.

## Negative / retry quorum

Default policy (`config/verification.example.json`):

- at least 3 negative profile observations,
- observations span at least 10 minutes,
- final negative observation is at least 10 minutes after the irreversible boundary,
- no positive publication signal exists.

Only then can reconciliation return `SAFE_TO_RETRY`, which transitions to `RETRY_WAIT`, **not** directly to READY.

An authorized human operator may explicitly record `manual_not_published`; this is an auditable operator action and can authorize `SAFE_TO_RETRY`. AI may never generate that evidence.

## Inconclusive observations

`inconclusive_profile_check` records "the surface was read and it proves nothing": several posts in
the verification window carry the same copy, no caption could be read at all, or the post
timestamps are too coarse to place a post inside the window. It is negative in the sense of "not a
publication signal", but it is deliberately **not** part of the negative quorum: a non-observation
must never accumulate into `SAFE_TO_RETRY`. Such a run stays `UNCERTAIN` and needs a human.

## Profile verifier safety

`DeclarativeProfileVerificationCollector` requires a known profile-ready marker before it can emit negative evidence. Failure to load the profile or unknown UI state throws/collects an error and cannot be interpreted as publication absence.

Real Instagram/TikTok/YouTube selectors are not guessed in W5. They remain a W8 private/test-account calibration gate.

## Restart behavior

If the process restarts while an intent is PUBLISHING/VERIFYING after boundary entry:

- the intent becomes `PUBLISH_UNCERTAIN`,
- the corresponding persisted attempt becomes `uncertain`,
- final action cannot be invoked a second time,
- reconciliation must run before any retry path can exist.

## Manual verifier

`ManualVerifierAdapter` supports two explicit operator actions:

- confirm published (+ optional permalink),
- confirm not published (mandatory note).

Both generate append-only evidence and optional runtime proof JSON.

## Local proof storage

`LocalVerificationArtifactSink` can capture:

- screenshot,
- DOM snapshot,
- metadata,
- manual verification JSON.

Artifacts are written with private filesystem permissions and remain under ignored runtime paths.
