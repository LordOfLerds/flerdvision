# CLAUDE.md — BINDING CLAUDE CODE CONTRACT

This repository automates real social accounts and is safety-critical.

## Mandatory startup behavior

At the beginning of every Claude Code session in this repository:

1. establish the current Git branch and exact HEAD SHA;
2. read `AGENTS.md`;
3. read `docs/22-ENGINEERING-EXECUTION-PROTOCOL.md`;
4. if the branch is `rebuild/headless-agentic-v1`, read **all of** `docs/23-CLAUDE-REAL-ACCOUNT-ACCEPTANCE.md` before editing code or touching a real account;
5. if the branch is `rebuild/headless-agentic-v1`, read **all of** `docs/FINISH-LINE.md` and the current finish issues #4–#7 before deciding what to do next;
6. inspect the exact current implementation rather than relying on prior chat claims.

For `rebuild/headless-agentic-v1`, `docs/23-CLAUDE-REAL-ACCOUNT-ACCEPTANCE.md` remains authoritative for irreversible-action safety. `docs/FINISH-LINE.md` is authoritative for **current prioritization and repair-loop discipline** and overrides older backlog/wave instructions that would reopen already-completed architecture.

## FINISH MODE — current branch priority

Until issues #4–#7 are closed, the mission is to finish and ship the existing product, not redesign it.

Binding facts for this phase:

- real verified posting has already been achieved on Instagram, TikTok and YouTube;
- a current regression or failed run does **not** mean the platform capability is unimplemented from zero;
- old issue #2 is superseded and must not be used as the current backlog;
- the only execution sequence is #4 -> #5 -> #6 -> #7.

Before any new code write, rerun the exact currently failing live step on the current authoritative HEAD and preserve its evidence. Then perform at most one evidence-backed minimal repair, focused test, full `npm test`, HEAD readback, and rerun of that same live step. Do not stack speculative fixes.

For the same observed failure class, a third code patch is forbidden until a short root-cause report explains why the first two models were wrong and why the next change fixes the class rather than one screenshot.

Do not add features, broad refactors, architecture layers, migrations, new UIs, new agent systems, new notification architecture or cleanup-only abstractions during finish mode unless a currently reproduced finish-line blocker makes that exact change necessary.

Do not modify unrelated platform routes. Before changing fingerprinted surface code, state which route qualifications will be invalidated; do not invalidate or requalify unrelated working routes merely to fix one route.

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
- PREPARE_ONLY qualification when the current route actually requires it;
- the bounded regression-test/repair loop in `docs/FINISH-LINE.md` before the irreversible boundary.

Do not restart first-time acceptance or repeat historical proof merely because a later regression failed. Requalify only the exact route whose current surface evidence requires it.

Stop and ask for human action only when it is genuinely required, especially:

- password entry;
- Google/social login consent;
- CAPTCHA;
- 2FA or account challenge;
- platform policy/copyright/account warning;
- explicit authorization required by the existing final-action gate;
- confirmation required by an existing cleanup contract.

After the human completes the requested action, continue the same flow instead of restarting from scratch unless persisted state demonstrably requires it.

## Repair behavior during the real test

If a reversible headless step fails before the final-action boundary:

1. preserve the failing evidence;
2. prove the failure on the exact current HEAD before editing;
3. identify the smallest implicated implementation surface;
4. add or update a focused regression test;
5. make the smallest safe repair on `rebuild/headless-agentic-v1`;
6. run the focused test and then `npm test`;
7. establish/read back the new exact branch HEAD;
8. repeat the exact failed live step before any other code change.

Never use a new failure observed after a patch as permission to make three more speculative changes in the same pass. Follow the same-failure patch budget in `docs/FINISH-LINE.md`.

Do not ask Luca to manually calibrate selectors, edit generated JSON/SQLite, or click through failed automation as a workaround.

If UI drift is involved, prefer semantic accessibility roles, labels, stable attributes, state readback and bounded waits. Account-specific brittle selectors are a last resort and must remain fail-closed.

## Irreversible-action invariants

Never weaken these rules to finish a test:

- exact target account identity must be proven;
- the route must be qualified for the exact release/surface contract required by the current runtime;
- any required PREPARE_ONLY proof must reach the final boundary without clicking it;
- irreversible-boundary state must be durable before the click;
- a successful click is not publication verification;
- verification/reconciliation is authoritative;
- `PUBLISH_UNCERTAIN` or an equivalent uncertain post-boundary state is a hard stop and MUST NOT be automatically retried;
- kill switches and account allowlists remain active;
- no production/customer account may be used outside the corresponding authorized gate;
- never weaken mode/confirmation gates merely to complete finish mode.

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

During finish mode:

- remain on `rebuild/headless-agentic-v1` until #7 explicitly promotes the proven branch;
- leave `main` untouched before #7;
- never merge during #4–#6;
- follow the small-slice/readback/safepoint protocol in `docs/22-ENGINEERING-EXECUTION-PROTOCOL.md`;
- do not claim CI evidence when only local tests ran;
- do not claim `REAL_SURFACE_VALIDATED`, `USER_ACCEPTED`, `CANARY_VALIDATED`, shipment or production readiness without the corresponding actual evidence.

## Required end-of-cycle report

During finish mode, after each live retry report the compact fields in `docs/FINISH-LINE.md`:

```text
HEAD
CURRENT_TICKET
PLATFORM / ROUTE
OBSERVED_RESULT
FINAL_ACTION_INVOKED: yes/no
VERIFICATION: VERIFIED / UNCERTAIN / not reached
TELEGRAM: received / missing / not applicable
EVIDENCE
CODE_CHANGED: yes/no
IF_CHANGED: commit + exact reason
NEXT_SINGLE_ACTION
```

Do not end a cycle by inventing a new roadmap. The next action must be the current finish ticket or the next numbered finish ticket.

Never turn a browser success toast, a typed handle, a manual click, or a human acknowledgement into publication verification.
