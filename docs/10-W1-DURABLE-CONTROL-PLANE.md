# 10 — W1 Durable Control Plane

Status: **implemented and locally verified**.

## Purpose

W1 makes Flerdvision restart-safe before any real ingress or browser automation exists. The control plane is the durable source of truth for logical publication work; UI state, bot acknowledgements and source-folder state are not.

## Persisted aggregates

### `publication_intents`
One logical publication target. `idempotency_key` is globally unique. Replaying the same logical publication returns the original intent instead of creating a duplicate. Reusing the key for a materially different target fails closed.

### `schedule_reservations`
One reservation per intent and at most one reservation for an account at an exact target time. It stores:
- business date,
- canonical slot,
- target instant,
- allowed start/end window.

### `worker_leases`
Short-lived ownership of a resource such as `publication-intent:<id>`. A second worker cannot claim an unexpired lease. Expired leases can be reaped/reacquired.

### `event_log`
Append-only audit log for intent transitions, reservations and leases. SQLite triggers reject `UPDATE` and `DELETE` against this table.

## Transaction rules

- intent insert + `intent.created` event are one transaction;
- state update + transition event are one transaction;
- schedule reservation + `READY -> SCHEDULED` are one transaction;
- lease ownership changes + lease event are one transaction.

SQLite uses:
- foreign keys ON,
- WAL journal,
- `synchronous=FULL`,
- busy timeout,
- explicit `BEGIN IMMEDIATE` around writes.

## Scheduling policy v1

Policy values are configuration/domain data, not embedded in platform adapters:

- timezone: `Europe/Vienna`,
- targets: `09:00`, `11:00`, `15:00`, `17:00`,
- publish window: target ±30 minutes,
- hard daily account cap: 4,
- standard minimum target spacing: 120 minutes,
- overflow disabled,
- overflow spacing field retained as 240 minutes for future policy versions but is unreachable while overflow is disabled.

`Intl.DateTimeFormat` is used to map Vienna local slots to UTC instants. Tests cover both 2026 DST directions.

## Bounded outage catch-up (E2)

A `SCHEDULED` intent whose ±`windowMinutes` window has ended is **not** immediately blocked. If it was never attempted (no `publish_attempts` row for the intent at all — see below), it stays a live claim candidate until `scheduledFor + catchUpHours` (policy field, default 4h), subject to the same spacing/cap/kill-switch/allowlist gates as an on-time claim, earliest-overdue-first. It is never silently pushed to the next slot and never reschedules itself past that deadline.

An intent that was ever attempted — even a "prepared" attempt with no final-action click, even one later marked `UNCERTAIN` — is never claimed a second time; `listPublishAttempts(intentId)` is the source of truth, checked before every catch-up claim.

Still `SCHEDULED` once the catch-up deadline passes -> `WAIVED` (reason `Slot verpasst, Nachholfenster abgelaufen`), plus one `MISSED_WINDOW` incident. `WAIVED` is terminal; there is no automatic re-post.

## Irreversible-boundary recovery

The future browser worker MUST move an intent to `PUBLISHING` **before invoking the final irreversible UI action**.

Restart recovery then follows:

- `PREPARING` + no live lease -> `SCHEDULED` (final action not yet crossed; safe retry),
- `PUBLISHING` + no live lease -> `PUBLISH_UNCERTAIN`,
- `VERIFYING` + no live lease -> `PUBLISH_UNCERTAIN`,
- active lease -> leave untouched,
- expired leases -> reap first,
- missed `SCHEDULED` window -> stays claimable (catch-up) until `scheduledFor + catchUpHours`, then `WAIVED`, never `BLOCKED`.

`PUBLISH_UNCERTAIN -> READY` is forbidden. Reconciliation must pass through `VERIFYING`; only proven negative evidence may later create a retry path.

## Admin read model

After build:

```bash
node dist/cli/admin.js summary --db runtime/flerdvision.sqlite
node dist/cli/admin.js intents --db runtime/flerdvision.sqlite
node dist/cli/admin.js events <intent-id> --db runtime/flerdvision.sqlite
node dist/cli/admin.js recover --db runtime/flerdvision.sqlite
```

The CLI is read-only except `recover`, which applies the documented restart policy.

## Tests added in W1

- DB survives close/reopen,
- idempotent replay creates one intent,
- conflicting idempotency payload fails,
- append-only trigger rejects tampering,
- two DB connections cannot own the same live lease,
- expired lease can be reacquired,
- Vienna slot conversion is DST-correct,
- four canonical slots pass,
- fifth future slot is rejected by daily cap,
- due job is claimed exactly once,
- missed window inside catch-up stays SCHEDULED and claimable; past the catch-up deadline it is WAIVED with exactly one incident,
- a never-attempted intent is claimable via catch-up; an attempted one never is, even after a restart rollback,
- pre-final restart safely rolls back,
- post-boundary restart becomes uncertain,
- live worker lease is not stolen,
- uncertain publication cannot return directly to READY.

## Known technical risk

The current adapter uses Node's built-in `node:sqlite` available in the development runtime (Node 22.16). That runtime emits an `ExperimentalWarning` for this module. This is deliberately contained behind `ControlPlaneStorePort`; the domain and application layers do not depend on the SQLite implementation.

Before customer go-live, one of these must be explicitly green:
1. pin a Node runtime where the chosen `node:sqlite` API is accepted for production and rerun the full persistence/failure suite, or
2. replace only `SqliteControlPlaneStore` with a mature SQLite driver while preserving the port contract and migration tests.

This is a runtime-driver decision, not an architecture change.
