# ADR 0004 — Source identity is stable; media mutation fails closed

Status: accepted in W2.

## Context
Content may arrive through today's Google Drive folder tree or a future source. Human folder paths can move or be renamed, and the same external object may be observed repeatedly. A production system must distinguish harmless repeated discovery from source media changing underneath an already accepted content identity.

## Decision
- Stable source identity is `(sourceId, externalObjectId)`, not a folder path.
- `SourceObservation.observationId` is deterministic for that external object in adapters that support it.
- Repeated sightings with the same media fingerprint are deduplicated and increment `seenCount`.
- A changed media fingerprint for the same external object is a conflict and fails closed. It is never treated as an in-place update of accepted content.
- Drive folder paths are interpretation metadata only.
- Drive discovery uses provider checksum/revision evidence; the future media-materialization step must compute/verify a local SHA-256 before any platform upload.

## Consequences
Moving a Drive file does not change publication identity. Editing/replacing the media after Flerdvision has first observed it requires an explicit operator/content lifecycle decision instead of silently publishing changed bytes.
