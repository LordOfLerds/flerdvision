# 08 — Implementation waves

Build everything required for a reliable release before enabling live customer publishing.

## W0 — Canonical model & repo [DONE]
- domain graph,
- ports/adapters boundaries,
- state machines,
- safe publish modes,
- handoff docs,
- initial state-machine tests.

Exit: architecture can be handed to another engineer/agent without oral context.

## W1 — Durable control plane [DONE — LOCAL VERIFICATION]
- SQLite schema + migrations,
- append-only transition/event log,
- repositories,
- leases/worker ownership,
- idempotency keys,
- scheduler in `Europe/Vienna`,
- daily caps and spacing policy,
- CLI/admin read model.

Exit: simulated jobs survive process/server restarts exactly once at the intent level.

## W2 — Pluggable ingress & source acknowledgement [DONE — LOCAL VERIFICATION]
- Drive read-only discovery adapter,
- configurable path interpreter for current creator/week/day schema,
- fixture source,
- duplicate observation handling,
- source disposition port,
- existing bot/Drive acknowledgement adapter as optional module.

Exit: today's source schema works, but tests prove a second fake schema can plug in without core changes.

## W3 — Browser identity subsystem [DONE — LOCAL VERIFICATION]
- persistent profiles per account,
- account registry,
- headed bootstrap flow,
- session health probes,
- account identity guard,
- secure operator remote access,
- no final publishing.

Exit: every test account can be opened/validated reliably after reboot.

## W4 — Platform adapters in PREPARE_ONLY [IMPLEMENTED LOCALLY; LIVE CALIBRATION IN W8]
- Instagram Web,
- TikTok Web/Studio,
- YouTube Studio,
- upload + fields + format options,
- screenshot/trace around every boundary,
- hard stop before final action,
- per-account capability registry (Trial Reel etc.).

Exit split: local/synthetic prepare kernel is green in W4; repeated real-platform prepare-only runs occur in W8 on the private/test account before any customer canary.

## W5 — Verification & uncertainty [DONE — LOCAL/SYNTHETIC VERIFICATION]
- UI receipt evidence,
- profile/post evidence,
- composite verification policy,
- `PUBLISH_UNCERTAIN` reconciliation,
- proof storage,
- manual verifier adapter.

Exit: synthetic and injected post-click failures never duplicate content.

## W6 — Notifications & operations
- current bot adapter,
- readiness summary,
- incident notification with evidence link,
- human resume/skip/waive actions,
- daily completion report,
- kill switch,
- minimal ops UI.

Exit: non-developer can understand and recover rehearsed incidents.

## W7 — AI repair engineering loop
- incident bundle redaction,
- Claude/Codex diagnostic prompt contract,
- patch branch workflow,
- regression test requirement,
- promotion gates.

Exit: UI-change incident can be diagnosed and patched without AI access to production secrets.

## W8 — E2E test-account release
- prepare-only E2E,
- private zero-viewer normal-post E2E where guarantee is valid,
- verify + cleanup,
- repeated runs,
- failure-injection campaign.

Exit: all `docs/06-GO-LIVE-GATES.md` pre-customer items green.

## W9 — Customer canary
- explicit customer/creator/account allowlist,
- one post,
- human observer,
- postmortem/readiness check,
- controlled ramp.

## W10 — Metrics automation (after publishing is stable)
- read UI metrics via replaceable adapters,
- tracker writer adapter,
- snapshots over time,
- reach-break anomaly detection,
- no coupling back into publish success semantics.
