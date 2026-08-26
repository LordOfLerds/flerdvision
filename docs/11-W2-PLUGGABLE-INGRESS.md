# 11 — W2 pluggable ingress and source acknowledgement

Status: **DONE — local verification**.

## Purpose

W2 makes today's Google Drive workflow usable without making today's folder structure part of the Flerdvision core.

The domain boundary is:

`ContentIngressPort -> SourceObservation -> IngressInterpreterPort -> ContentItem`

External acknowledgement is separate:

`VerifiedPublication(s) -> SourceAcknowledgementService -> SourceDispositionPort`

A change in how content arrives or how humans are told that posting is complete must not require changes to scheduling, browser publishing, verification or publication semantics.

## Implemented source adapters

### `GoogleDriveFolderIngressAdapter`
- read-only recursive discovery,
- pagination,
- configurable root/depth/file types,
- stable observation ID from source + Drive file ID,
- path metadata retained for interpretation,
- `md5Checksum` preferred as source media fingerprint,
- Drive version + size is only a revision fallback when checksum is unavailable,
- no move/rename/delete is performed by ingress.

`GoogleDriveRestReadClient` contains the Drive REST read transport but authentication is injected through `AccessTokenProvider`; credentials are deliberately not embedded in the adapter.

### `FixtureIngressAdapter`
Deterministic source for unit/integration tests and future schema rehearsals.

## Implemented interpreters

### `CurrentCreatorWeekDayPathInterpreter`
Supports the known structural shape:

`Creator / arbitrary-week-segment / 01_Montag..07_Sonntag / optional-format-folder / file`

The actual creator folder aliases are configuration, not code.

Business date is resolved only from explicit data:
1. `businessDate` metadata, or
2. `weekStartDate` metadata + numbered day folder, or
3. configured `weekStartBySegment` + numbered day folder.

It does **not** guess the week from today's date. This is intentional because next-week material may be uploaded early.

Format folders are optional hints only and are configurable. The exact leaf naming/content convention inside the current day folders is still an open operating fact and therefore is not hard-coded.

### `MetadataFieldIngressInterpreter`
Proves a completely different future source can pass creator/date/format metadata directly without changing the ingress service or domain.

## Durable duplicate and mutation handling

SQLite migration 2 adds:
- `source_observations`,
- `content_items`,
- `source_dispositions`.

Rules:
- same `(sourceId, externalObjectId)` + same fingerprint => duplicate sighting, `seenCount += 1`, no second content item;
- same source object + changed media fingerprint => conflict, no overwrite;
- one source observation can materialize exactly one content item;
- source decisions are durable and cannot silently change after acceptance/block/ignore;
- W1 databases migrate in place to schema migration 2.

A content item points to a path-independent immutable source locator (`gdrive://file/<id>` for Drive) rather than a human folder path. Folder moves therefore do not change publication identity.

## Source acknowledgement adapters

### `NoopSourceDispositionAdapter`
Safe default. Does nothing.

### `WebhookSourceDispositionAdapter`
Generic bridge for the existing/future bot or workflow service. Includes a deterministic `idempotency-key` header. No Telegram/WhatsApp-specific semantics are baked into the core.

### `GoogleDriveAppPropertiesDispositionAdapter`
Optional non-moving Drive acknowledgement. Writes only configured `appProperties` when explicitly enabled. It is not wired by default.

### `CompositeSourceDispositionAdapter`
Allows multiple acknowledgement sinks without changing application logic.

## Acknowledgement semantics

`SourceAcknowledgementService` records completion only after the external disposition adapter succeeds. Repeated completion calls with the same publication IDs are idempotent at the Flerdvision store.

Adapters used for external side effects must themselves be idempotent or accept the deterministic operation key. This matters for a crash in the small interval after the external sink succeeds but before local acknowledgement is persisted. Drive appProperties are naturally idempotent; the webhook adapter sends an idempotency key. The exact existing bot integration is therefore deferred until its receiver contract is known, rather than guessed.

Blocked-source notifications are retried on the next duplicate observation when the external sink was temporarily unavailable.

## Current-source facts deliberately still open

The screenshots establish creator folders and day folders, but do not establish all leaf conventions for:
- Reel vs Trial Reel vs TikTok vs Short,
- caption/description source files,
- week-folder naming/date semantics,
- whether completion should remain a bot checkmark, a Drive mark, or both.

W2 therefore provides the replaceable adapters/configuration points but does not invent those facts.

## W2 automated evidence

At W2 completion:
- TypeScript build: PASS
- full suite: **33 passed / 0 failed**
- current creator/week/day fixture: PASS
- entirely different metadata schema: PASS
- Drive recursive read discovery: PASS
- Drive pagination: PASS
- duplicate source observation: PASS
- changed source fingerprint conflict: PASS
- acknowledgement idempotency: PASS
- blocked acknowledgement retry after sink outage: PASS
- W1 -> W2 database migration: PASS

## Not live

No real Google Drive credential has been configured and no real Drive write has been performed. No social account/browser capability exists yet. Customer publishing remains physically unavailable.
