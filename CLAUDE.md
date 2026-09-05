# CLAUDE.md — BINDING CLAUDE CODE CONTRACT

This repository automates real social accounts and is safety-critical.

## Mandatory startup behavior

At the beginning of every Claude Code session:

1. establish current branch and exact HEAD SHA;
2. read `AGENTS.md`;
3. read `docs/22-ENGINEERING-EXECUTION-PROTOCOL.md`;
4. on `recovery/operator-product-v1`, read **all of** `docs/25-PRODUCT-RECOVERY-GRAPH.md` before choosing work;
5. on `rebuild/headless-agentic-v1`, follow its historical `docs/FINISH-LINE.md` / real-account acceptance rules instead;
6. inspect the exact current implementation and evidence rather than relying on prior chat claims.

On the recovery branch, `docs/25-PRODUCT-RECOVERY-GRAPH.md` is authoritative for product target, work-package order, keep/refactor/delete decisions and exit gates. `docs/22-ENGINEERING-EXECUTION-PROTOCOL.md` remains authoritative for slice size, read/write discipline and evidence claims.

## Recovery mission

Build one understandable product path for:

- **Luca Acceptance** — controlled real tests and `test-now` outside normal slots;
- **Brother Production** — one independent VPS with its own Drive, social sessions, Telegram, state and evidence;
- multiple business **customers** inside one installation, grouped only for scheduling/operator UX rather than as SaaS tenants.

Do not start a full rewrite. Preserve the durable domain/safety core and work along WP0 -> WP10 in `docs/25-PRODUCT-RECOVERY-GRAPH.md`.

The current priority starts at **WP0**. Do not skip to operator convenience or legacy deletion while deterministic engineering/runtime prerequisites are unresolved.

## Slice behavior

Before every code/doc write on the recovery branch, state:

```text
WP
CURRENT_HEAD
FORWARD_EDGE_CHANGED
REVERSE_EDGE_CHANGED
QUALIFICATION_IMPACT
SAFETY_IMPACT
DELETE_IMPACT
```

Then follow the small-slice protocol in `docs/22-ENGINEERING-EXECUTION-PROTOCOL.md`.

After every safepoint, establish/read back authoritative HEAD and report:

```text
WP
NEW_HEAD
FILES_CHANGED
EVIDENCE_LEVEL
TESTS_ACTUALLY_RUN
OPEN_BLOCKER
NEXT_SINGLE_SLICE
```

A write response SHA alone is never sufficient evidence.

## Test discipline

Do **not** run the complete historical suite after every tiny repair merely by habit.

Use this policy during recovery:

1. smallest focused regression test for the changed behavior;
2. affected subsystem/platform contract tests where available;
3. full `npm test` only when required by the current WP gate, before a real frozen acceptance candidate, or before minting/promoting a release candidate.

Until WP0 introduces canonical layered test scripts, select existing repository-owned focused tests explicitly. Never execute an AI/user-provided arbitrary shell command.

A failed CI/full suite remains a blocker for a frozen real acceptance candidate. Do not relabel a focused/local pass as full-suite or CI evidence.

## Frozen acceptance rule

Code repair and real acceptance are separate loops.

When a candidate SHA enters WP8 Luca Acceptance:

- freeze that SHA for the active acceptance run;
- do not edit code mid-run to chase the next platform screen;
- let unrelated route workers finish independently;
- preserve failure evidence for a failed route;
- pause/freeze only the affected route as required;
- create a separate repair slice/branch after the run/evidence boundary;
- mint a **new** candidate SHA after focused/affected tests and required full-suite evidence;
- requalify/retest only affected routes unless evidence proves broader impact.

Never increase a verification limit or change platform code live merely because one verification poll did not find the object quickly enough.

## Current product path

The supported implementation entrypoint remains:

```bash
npm run flerdvision -- <command>
```

The recovery graph will consolidate user-facing behavior behind `flerdvision` and Telegram. Existing specialist CLIs are engineering/support surfaces unless and until a WP explicitly migrates/removes them.

Never use these legacy product paths to make a failed headless/product run appear successful:

```text
legacy:control-center
legacy:setup-ui
legacy:ops
legacy:platform-ui
legacy:e2e
```

Legacy code may only be deleted after the replacement graph edge has proven parity according to WP10.

## Real-account execution behavior

When Luca asks to test the real path, execute reversible repository-owned steps autonomously as far as current gates allow. Ask for human action only when it is genuinely required, especially:

- password entry;
- Google/social consent/login;
- CAPTCHA;
- 2FA/account challenge;
- platform policy/copyright/account warning;
- an explicit irreversible authorization required by the current gate;
- cleanup confirmation required by a current contract.

After human action, continue from persisted state instead of restarting from zero unless the actual state requires a restart.

Do not ask Luca or the brother to edit generated route IDs, SQLite state, qualification receipts, selector matrices or internal evidence files.

## Runtime/repair behavior

If a reversible step fails before the final-action boundary:

1. preserve exact evidence and failure phase;
2. identify the affected route/platform and whether unrelated routes can continue;
3. create/update one incident/root-cause representation rather than many asset-level blocker messages;
4. use deterministic diagnosis first;
5. where policy permits, sanitized AI diagnosis may propose a bounded candidate;
6. repair code only in an engineering repair slice/branch, never by self-modifying Brother Production;
7. run focused + affected contract tests;
8. run the full suite only when the WP/release gate requires it;
9. read back exact new HEAD before any live retry.

`PUBLISH_UNCERTAIN` never enters an automatic repair/retry path. It belongs to deterministic verification/reconciliation only.

## Operator/product UX target

Normal operator output must be customer-centric and concise:

`customer -> channel -> video -> local time -> status`.

Do not expose route IDs, fingerprints, lease owners or database IDs in normal Telegram messages.

The recovery target includes:

- clear `/plan` concrete daily plan grouped by customer;
- separate schedule/rule view;
- schedule/capacity edits through shared command services;
- success notification with final verified screenshot + permalink;
- failure notification with concise cause + failure screenshot + diagnosis state;
- diagnostic clip only when useful on failure, not full run video on success;
- one evolving incident message instead of notification spam;
- clickable protected remote-browser link for login/challenge human actions;
- `test-now` only in Luca Acceptance and through the normal PublicationIntent pipeline.

## Irreversible-action invariants

Never weaken these rules:

- exact target account identity must be proven;
- route qualification required by the current runtime must be valid;
- irreversible-boundary state must be durably persisted before the click;
- a successful click or success toast is not publication verification;
- verification/reconciliation is authoritative;
- `PUBLISH_UNCERTAIN` is a hard stop and MUST NOT be blindly retried;
- kill switches and account/channel allowlists remain active;
- no generic secret-live bypass may be introduced;
- AI cannot own final-action authorization;
- production code cannot self-modify from an AI repair on the Brother VPS.

## Credential and evidence boundaries

Never expose or commit:

- passwords;
- session cookies;
- OAuth refresh tokens;
- browser-profile material;
- private credential files;
- raw secrets.

AI helpers may receive sanitized semantic/evidence bundles only. They may not receive credentials, raw browser profiles, own final-action authorization, edit safety state or free-form click production accounts.

## Git and promotion discipline

On the recovery branch:

- remain on `recovery/operator-product-v1` unless Luca explicitly changes target or a repair sub-branch is required by the graph;
- keep `main` as release target, not active repair scratch space;
- promotion evidence is release-SHA strict: `CI -> LUCA_ACCEPTANCE -> BROTHER_CANARY -> BROTHER_PRODUCTION`;
- do not claim `REAL_SURFACE_VALIDATED`, `USER_ACCEPTED`, `CANARY_VALIDATED`, shipment or production readiness without actual corresponding evidence;
- do not delete legacy paths before replacement parity and reference checks.

Never turn a browser success toast, typed handle, manual click or human acknowledgement into publication verification.
