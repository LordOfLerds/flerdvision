# ADR 0007 — Operations use durable incidents/outbox and independent kill switches

## Decision

Operational visibility is projected from the durable domain graph into deduplicated incidents. Notifications use a durable outbox behind `NotificationPort`. Human recovery is explicit and audited. Kill switches are persisted independently and gate both work claiming and entry into the irreversible publish boundary.

## Why

A messenger must not become the source of truth. Bot outages must not lose incident state. Repeated polling must not spam operators. A human acknowledgement must not be confused with publication verification. A global emergency stop must work even if notifications are unavailable.

## Consequences

- Current bot integration is replaceable.
- Notification failures are retryable without duplicating messages.
- `PUBLISH_UNCERTAIN` remains governed only by W5 reconciliation.
- The local Ops UI is a control surface, not a publishing engine.
- An already-crossed irreversible boundary is not magically cancellable by a later kill switch.
