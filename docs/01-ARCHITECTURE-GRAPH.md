# 01 — Architecture graph

The graph is the source of architectural reasoning. Every forward edge should have a useful reverse lookup.

```text
ExternalSource
  -> ContentIngressPort
  -> SourceObservation
  -> IngressInterpreterPort
  -> ContentItem
  -> DistributionPlan
  -> PublicationIntent
  -> ScheduleReservation
  -> PublishAttempt
  -> VerificationEvidence
  -> VerificationDecision
  -> VerifiedPublication
  -> MetricSnapshot

Creator -> SocialAccount -> BrowserIdentity -> SessionHealth -> AccountIdentityGuard -> PublishAttempt
Creator -> RoutingPolicy -> DistributionPlan
PostingPolicy -> SlotPolicy -> ScheduleReservation

PublishAttempt -> EvidenceBundle
Failure/Unknown -> Incident -> EvidenceBundle -> Diagnosis -> RepairProposal
RepairProposal -> CodeChange -> TestEvidence -> Release

NotificationSink <- DomainEvent
SourceDisposition <- VerifiedPublication / BlockedOutcome
```

## Canonical nodes

### SourceObservation
An immutable observation that an external source contains a candidate artifact. It carries external IDs/path hints but no publishing assumptions.

### ContentItem
The canonical accepted media item. It references source provenance and a stable source-media fingerprint. Drive discovery uses the provider checksum when available; later materialization must compute/verify a local SHA-256 before upload. It does **not** encode a Drive folder path as business truth.

### DistributionPlan
The deterministic interpretation of "where this content should go". Built from creator/account/policy configuration and explicit source metadata.

### PublicationIntent
One target publication: content + platform + account + format + copy version + intended schedule. This is the unit of idempotency.

### PublishAttempt
One execution against a user interface. It records release SHA, browser identity, exact media SHA-256 and the irreversible-boundary timestamps. `irreversibleBoundaryEnteredAt` is persisted **before** the actual final UI action. It is never success by definition.

### VerificationEvidence
An append-only typed observation with provenance: e.g. profile permalink found, profile match, success receipt, conservative negative profile check, or authorized manual verification.

### VerificationDecision
An append-only policy verdict (`VERIFIED`, `SAFE_TO_RETRY`, `UNCERTAIN`) that names exactly which evidence IDs were considered sufficient for that verdict.

### VerifiedPublication
Created only when a verifier policy concludes that required evidence proves the post exists on the intended account.

## Reverse trace requirements

Given a `VerifiedPublication`, operators must be able to answer:
- Which source file produced it?
- Which exact bytes/hash were used?
- Which creator, target account, slot and copy version were intended?
- Which browser identity performed the attempt?
- What evidence proved success?
- Which code/release version executed it?

Given a `SourceObservation`, operators must be able to answer:
- Was it accepted, rejected, blocked or ignored?
- Which publication intents were generated?
- Which targets are verified / pending / blocked?
- Was/when was source acknowledgement written back?

## Graph invariants

- No `VerifiedPublication` without persisted evidence references.
- A durable irreversible-boundary record must exist before a final UI action invoker can run.
- Post-boundary failure/crash is uncertain, never safely failed.
- One PublicationIntent has at most one immutable VerifiedPublication.
- Incomplete positive publication evidence blocks automatic retry.
- Negative absence evidence is valid only after a known-ready profile surface and policy quorum.
- No `PublishAttempt` without `PublicationIntent`.
- No `PublicationIntent` without accepted `ContentItem` provenance.
- One intent has one stable idempotency key independent of retries.
- A source acknowledgement may lag publication; it never leads it.
- Re-observing the same external object with a different media fingerprint is a conflict, never an implicit content update.
- Source acknowledgement/disposition is not publication verification.
- A BrowserIdentity maps to one SocialAccount and one isolated profile key.
- A PublishAttempt may not prepare media unless AccountIdentityGuard has current positive exact-account evidence.
- Browser-profile ownership is exclusive locally and durably.
