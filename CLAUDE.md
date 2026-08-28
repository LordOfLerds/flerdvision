# CLAUDE.md — BINDING CLAUDE CODE CONTRACT

This repository automates real social accounts and is safety-critical.

## Mandatory startup behavior

At the beginning of every Claude Code session in this repository:

1. establish the current Git branch and exact HEAD SHA;
2. read `AGENTS.md`;
3. read `docs/22-ENGINEERING-EXECUTION-PROTOCOL.md`;
4. if the branch is `rebuild/headless-agentic-v1`, read **all of** `docs/23-CLAUDE-REAL-ACCOUNT-ACCEPTANCE.md` before editing code or touching a real account;
5. inspect the exact current implementation rather than relying on prior chat claims.

For `rebuild/headless-agentic-v1`, `docs/23-CLAUDE-REAL-ACCOUNT-ACCEPTANCE.md` is the canonical real-account test procedure and overrides older setup/calibration instructions that conflict with it.

## Current headless product path

The supported product entrypoint is:

```bash
npm run flerdvision -- <command>
```

Use the canonical host-local `flerdvision.json` plus the repository compiler/runtime. Do not make the operator configure generated route IDs, posting-profile IDs, selector matrices, replay receipts or SQLite state.

The legacy HTTP surfaces remain rollback/engineering code only. During headless acceptance, do not use these commands to bypass a failure:

```text
legacy:control-center
legacy:setup-ui
legacy:ops
legacy:platform-ui
legacy:e2e
```

## Real-account execution behavior

When Luca asks to test the real path, execute as far as possible without repeatedly asking for permission or restating the plan.

Proceed automatically through repository-owned, reversible steps such as:

- branch/readback checks;
- `npm install`;
- `npm test`;
- bootstrap/spec validation;
- Drive source discovery;
- doctor/readiness checks;
- source scan/planning;
- PREPARE_ONLY qualification;
- regression-test/repair loops before the irreversible boundary.

Stop and ask for human action only when it is genuinely required, especially:

- password entry;
- Google/social login consent;
- CAPTCHA;
- 2FA or account challenge;
- platform policy/copyright/account warning;
- explicit authorization immediately before the one-shot real private final publish action;
- confirmation that the verified private test post was manually deleted before recording cleanup.

After the human completes the requested action, continue the same acceptance flow instead of restarting from scratch unless the persisted state requires it.

## Repair behavior during the real test

If a reversible headless step fails before the final-action boundary:

1. preserve the failing evidence;
2. identify the smallest implicated implementation surface;
3. add or update a regression test;
4. make the smallest safe repair on `rebuild/headless-agentic-v1`;
5. run the focused test and then `npm test`;
6. establish/read back the new exact branch HEAD;
7. repeat the real PREPARE_ONLY step.

Do not ask Luca to manually calibrate selectors, edit generated JSON/SQLite, or click through the failed automation as a workaround.

If UI drift is involved, prefer semantic accessibility roles, labels, stable attributes, state readback and bounded waits. Account-specific brittle selectors are a last resort and must remain fail-closed.

## Irreversible-action invariants

Never weaken these rules to finish a test:

- exact target account identity must be proven;
- the route must be qualified for the exact release/surface contract;
- the final action must be reached first in PREPARE_ONLY without clicking it;
- a private final action must use the retained prepared session and the existing one-shot permit/gates;
- irreversible-boundary state must be durable before the click;
- a successful click is not publication verification;
- verification/reconciliation is authoritative;
- `PUBLISH_UNCERTAIN` or an equivalent uncertain post-boundary state is a hard stop and MUST NOT be automatically retried;
- kill switches and account allowlists remain active;
- no production/customer account is used in the first acceptance;
- `--mode production` is forbidden in the first acceptance.

## Credential and evidence boundaries

Never expose or commit:

- passwords;
- session cookies;
- OAuth refresh tokens;
- browser-profile material;
- private credential files;
- raw secrets.

`info@flerdvision.com` is the intended Flerdvision owner/contact for the Google/Drive acceptance where relevant, but credentials for that account remain human/private input.

AI helpers may receive sanitized semantic snapshots and propose locators. They may not receive credentials, own final-action authorization, edit safety state, or free-form click production accounts.

## Git discipline

For the real acceptance:

- remain on `rebuild/headless-agentic-v1` unless Luca explicitly changes the target;
- leave `main` untouched;
- never merge during the acceptance session;
- follow the small-slice/readback/safepoint protocol in `docs/22-ENGINEERING-EXECUTION-PROTOCOL.md`;
- do not claim CI evidence when only local tests ran;
- do not claim `REAL_SURFACE_VALIDATED`, `USER_ACCEPTED`, `CANARY_VALIDATED`, or production readiness without the actual corresponding evidence.

## Required end-of-session report

For a real-account acceptance session, finish with the exact evidence fields required by `docs/23-CLAUDE-REAL-ACCOUNT-ACCEPTANCE.md`, including branch, HEAD SHA, test result, source/Drive state, account identity, PREPARE_ONLY, surface/replays, private final action, verification, cleanup, doctor result, repairs/commits, evidence level, blockers and next safe action.

Never turn a browser success toast, a typed handle, a manual click, or a human acknowledgement into publication verification.
