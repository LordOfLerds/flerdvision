# 04 — First-time setup

First-time setup is a product feature. It must be repeatable and documented, not tribal knowledge.

## Phase 0 — Server/bootstrap

Recommended initial shape:
- one stable DACH/EU server,
- 4 vCPU / 8 GB RAM class,
- persistent SSD,
- stable public IP,
- `Europe/Vienna`,
- encrypted-at-rest host/volume where possible,
- Tailscale for operator access,
- no public VNC/dashboard exposure.

Logical processes:
1. **Control Plane** — DB, scheduler, policies, notifications, incident state.
2. **Browser Worker** — persistent browser identities and UI automation.

They can live on the same server initially.

## Phase 1 — Repository setup

1. clone private repo,
2. create `.env` from `.env.example`,
3. run `./ops/bootstrap-runtime.sh`,
4. initialize DB/migrations by running any admin/browser command,
5. start in `FLERDVISION_MODE=disabled`,
6. run `npm run check`.

## Phase 2 — Source setup

Current Drive integration starts read-only:
1. configure root/source identifiers,
2. configure folder/path interpretation profile,
3. run discovery against historical fixtures,
4. compare interpreted creator/date/type with humans,
5. no source mutation until acceptance tests pass.

## Phase 3 — Account/browser bootstrap

For each social account:
1. create stable internal `account_id` and `browserIdentityId`,
2. register non-secret identity metadata with `npm run browser -- register ...`,
3. open the isolated persistent browser via `npm run browser -- bootstrap ...` through private operator access,
4. human performs normal login and 2FA,
5. run a session probe and verify the exact target handle,
6. `AccountIdentityGuard` must report `HEALTHY`,
7. never commit cookies/profile data/passwords.

Detailed W3 commands and invariants: `docs/12-W3-BROWSER-IDENTITY.md`.

No password automation is required. The retained browser session is the runtime identity.

## Phase 4 — Notification setup

Connect one `NotificationPort` adapter and prove:
- readiness message,
- incident with screenshot link,
- human-action request,
- daily completion summary.

The existing bot/channel can be adapter #1 without making it the domain contract.

## Phase 5 — Publish gate

Default state is physically incapable of final publishing.

Modes:
- `disabled` — no browser mutation.
- `prepare_only` — upload/fill form, hard stop before final action.
- `test_account` — final action only for explicit test allowlist.
- `canary` — explicit small production allowlist and limits.
- `production` — all configured approved accounts.

A final publish action requires both the mode and a separate `ALLOW_FINAL_PUBLISH=true` hard gate.
