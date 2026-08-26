# 02 — Ports and adapters

Flerdvision uses hexagonal architecture so today's workflow can change without replacing the domain.

## A. Content ingress — intentionally open

Domain port: `ContentIngressPort`

It returns `SourceObservation[]` and nothing more. Mapping today's Drive layout to creator/date/type is handled by an `IngressInterpreter`.

Initial adapters:
- `GoogleDriveFolderIngressAdapter` — reads existing creator/week/day schema.
- `FixtureIngressAdapter` — deterministic test fixtures.

Future adapters without domain changes:
- different Drive layout,
- bot-submitted links,
- upload portal,
- S3/object storage,
- manual queue.

### Important separation

`Google Drive path -> creator/date/content hints` is configuration, not code in the scheduler.

## B. Source acknowledgement — intentionally open

Domain port: `SourceDispositionPort`.

Possible adapters:
- move/tag Drive file,
- write a status file,
- react/confirm in the existing bot/channel,
- update an external tracker,
- no-op.

The core emits `ContentCompleted` / `ContentBlocked`; an adapter decides how today's human workflow is updated.

## C. Publishing

Domain port: `PublisherPort`.

Adapters are platform/UI-specific:
- `InstagramWebPublisher`
- `TikTokWebPublisher`
- `YouTubeStudioPublisher`
- future `InstagramMobileUiPublisher`

A publisher returns a **publish attempt result**, not "posted=true".

## D. Verification — intentionally open

Domain port: `PublicationVerifierPort`.

Strategies can be composed:
- `ProfileEvidenceVerifier`: navigate to target profile and find matching new post.
- `UiReceiptVerifier`: use platform success UI as supporting evidence.
- `ManualAckVerifier`: explicit operator confirmation.
- `CompositeVerifier`: require a policy-defined evidence quorum.

This is the seam that lets confirmation behavior evolve later.

## E. Notifications

Domain port: `NotificationPort`.

Adapters:
- existing bot/channel,
- Telegram/Discord/Slack later,
- email,
- web dashboard,
- test recorder.

Only incidents, readiness summaries and completion summaries should interrupt users by default.

## F. Persistence

Domain port: repositories/event log.

MVP: SQLite WAL on persistent volume.
Future: PostgreSQL can replace it because orchestration depends on repository contracts, not SQLite SQL scattered through the codebase.

## G. Browser execution

`BrowserWorker` is physically separable from `ControlPlane`.

MVP may colocate both on one inexpensive server. Later the browser worker can move to a stable Austrian office connection/mini-PC while the control plane remains on a VPS. No domain change is required.
