# W6 — Operations, notifications and human recovery

Status: **DONE under local/synthetic verification**.

W6 turns the durable state graph into an operator-facing system without coupling the core to one bot, messenger or dashboard.

## 1. Operations graph

`runtime state/evidence -> OperationsIncidentProjector -> Incident -> NotificationOutbox -> NotificationPort`

Human recovery is separate:

`Incident -> HumanRecoveryService -> guarded state transition / Waive / Resolve`

Kill switches are independent of notifications:

`KillSwitchStore -> KillSwitchGate -> DueWorkClaimer + DurableFinalActionService`

## 2. Incidents

Incidents are durable and deduplicated by stable fingerprints. Repeated projection of the same underlying observation does not create alert spam. If a resolved condition later recurs, the same incident identity is reopened and the occurrence counter advances.

Initial deterministic incident classes:
- `AUTH_REQUIRED`
- `CHALLENGE`
- `IDENTITY_MISMATCH`
- `MISSED_WINDOW`
- `PUBLISH_UNCERTAIN`
- `SOURCE_BLOCKED`
- `PLATFORM_CAPABILITY_MISSING`
- `BROWSER_UNREACHABLE`
- `UI_UNKNOWN`
- selected warning/error classes reserved for W8 calibration.

No AI is needed to classify these known states.

## 3. Human recovery rules

Allowed operator actions:
- acknowledge incident,
- resolve incident with note,
- resume a `BLOCKED` intent only if its browser identity is healthy and its original schedule window remains valid,
- waive an intent with an explicit reason,
- set/clear global/account/platform kill switches.

Hard rules:
- `PUBLISH_UNCERTAIN` cannot be bypassed with Resume. It must go through W5 reconciliation.
- Resume never creates catch-up publishing after a missed window.
- Human actions are append-only audit records.
- Resolving an incident does not itself prove a post exists or does not exist.

## 4. Kill switches

Scopes:
- global (`GLOBAL:*`),
- one stable internal account ID,
- one platform.

The gate is checked before due work is claimed and again immediately before W5 enters the durable irreversible boundary. A kill switch does not pretend to cancel an irreversible action that has already crossed that boundary.

## 5. Notification outbox

Notifications are persisted before delivery. One notification message may have multiple channel deliveries.

Properties:
- deterministic dedupe key,
- delivery status `PENDING|SENT|FAILED`,
- retry count and last error,
- default retry delay 60 s,
- default maximum 8 delivery attempts,
- webhook idempotency key is the notification dedupe key.

Implemented adapter:
- generic `WebhookNotificationAdapter` for today's or a future bot receiver.

This is deliberately not hard-coded to Telegram/WhatsApp/Slack.

## 6. Daily operations cadence

`OperationsCycleService` is idempotent and safe to poll repeatedly. In `Europe/Vienna` it can enqueue:
- readiness summary from 08:30 onward,
- incident alerts as new incidents open,
- completion/incomplete summary from 17:30 onward.

Outbox dedupe prevents repeated polling from sending duplicate daily messages.

## 7. Minimal Ops UI

`OpsHttpServer` uses Node's built-in HTTP server and binds to `127.0.0.1` by default.

Security:
- Basic authentication required,
- CSRF token required for state-changing forms,
- no public bind by default,
- intended for Tailscale/WireGuard/SSH-tunnel access,
- optional operator browser-session link can point to a separately protected browser worker UI.

The UI shows daily status, active incidents, deterministic recovery guidance, human actions and kill switches.

## 8. CLI

Examples:

```bash
npm run ops -- cycle
npm run ops -- incidents
npm run ops -- readiness 2026-08-26
npm run ops -- completion 2026-08-26
npm run ops -- kill-switch GLOBAL '*' on 'maintenance'
npm run ops -- serve
```

`FLERDVISION_NOTIFICATION_WEBHOOK_URL` enables dispatch through the generic bot bridge.

## 9. Verification boundary

W6 does **not** add any real social final-action implementation. All W5 verification semantics remain authoritative.

Customer publishing remains blocked until W8 is green and W9 canary is explicitly approved.
