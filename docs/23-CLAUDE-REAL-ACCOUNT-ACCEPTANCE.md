# Claude Real-Account Acceptance — BINDING

Status: **BINDING for Claude Code sessions testing `rebuild/headless-agentic-v1` on a real Flerdvision account.**

Owner/contact: `info@flerdvision.com`

This document is the canonical execution path for the first real headless acceptance. It does not authorize merging, production rollout, customer publishing, bypassing safeguards, editing runtime state by hand, or falling back to legacy HTTP UIs.

## 1. Mission

Prove the real headless path on one exact Git SHA:

```text
canonical flerdvision.json
-> Google Drive source discovery
-> persistent browser identity
-> source scan + deterministic plan
-> autonomous surface discovery
-> three PREPARE_ONLY replays
-> calibrated route
-> scheduled intent
-> optional one-shot PRIVATE_E2E final action
-> deterministic verification
-> human deletion of the private test post
-> cleanup receipt
-> doctor/readback
```

The normal entrypoint is exclusively:

```bash
npm run flerdvision -- <command>
```

Do **not** use `legacy:control-center`, `legacy:setup-ui`, `legacy:ops`, `legacy:platform-ui`, or `legacy:e2e` to make a failed headless run appear successful.

## 2. Mandatory read order

Before changing code or touching a real account, Claude MUST read:

1. `CLAUDE.md`
2. `AGENTS.md`
3. `docs/22-ENGINEERING-EXECUTION-PROTOCOL.md`
4. this file
5. the exact implementation file implicated by any failure

Repository docs and current code beat assumptions from chat history.

## 3. Non-negotiable rules

Claude MUST:

- work only on `rebuild/headless-agentic-v1` unless Luca explicitly changes the target;
- establish and print the exact branch HEAD before edits and before any real-account run;
- keep the working tree clean before a real-account acceptance run;
- run `npm test` on the exact SHA before touching the real social surface;
- use `info@flerdvision.com` as the intended Flerdvision Google/Drive owner contact when relevant;
- use only repository-owned commands;
- let the human perform login, password entry, CAPTCHA, 2FA, challenge resolution and policy acknowledgements;
- preserve one browser profile per BrowserIdentity;
- require exact-account identity proof before upload;
- treat a final click only as action evidence, never as publication verification;
- stop on `PUBLISH_UNCERTAIN`, identity mismatch, challenge, policy warning, copyright warning, unknown UI state or ambiguous irreversible target;
- add a regression test for any code repair before repeating the real PREPARE_ONLY run;
- report evidence levels literally: CODE_ON_BRANCH, LOCAL_FOCUSED_TESTED, FRESH_CLONE_FULL_SUITE, REAL_SURFACE_VALIDATED, etc.;
- leave `main` untouched and never merge this branch during acceptance.

Claude MUST NOT:

- edit SQLite to advance states;
- hand-edit generated route IDs, evidence, qualification receipts or surface status to pass a gate;
- type a claimed account handle as a substitute for observed browser identity;
- manually click Share/Publish during PREPARE_ONLY and then claim the automation worked;
- retry an irreversible publish after an uncertain outcome;
- expose cookies, passwords, OAuth refresh tokens, browser-profile material or raw credentials to prompts, logs, git or issue comments;
- loosen kill switches, identity guards, durable-boundary persistence, verification, reconciliation or account allowlists just to finish the test;
- use production/customer accounts for the first acceptance;
- run `--mode production` during this acceptance.

## 4. Session bootstrap

Run from the repository root:

```bash
git fetch origin
git switch rebuild/headless-agentic-v1
git pull --ff-only

git status --short
git rev-parse HEAD
node --version
npm install
npm test

export FLERDVISION_RELEASE_SHA="$(git rev-parse HEAD)"
export FLERDVISION_SPEC="$HOME/flerdvision.json"
export TZ=Europe/Vienna
```

### Google OAuth client (prerequisite for every command, not only drive-auth)

A `google_drive` source needs an OAuth client that only the human owner can create. Without it
`drive-auth` refuses outright, and `bootstrap` refuses too once a credential exists, because it
must refresh the access token. Export the pair for **every** `npm run flerdvision` invocation,
not just the authorization step:

```bash
set -a; . "$HOME/.flerdvision-google-oauth.env"; set +a
```

Create the client once, signed in as the account that can open the Drive folder:

1. a Google Cloud project;
2. the **Google Drive API** enabled on it;
3. an OAuth consent screen whose **Branding** page is complete -- app name, user support email
   and developer contact are mandatory. While Branding is incomplete Google blocks the flow with
   "verification has not been completed", which reads like a verification problem and is not one;
4. publishing status **Testing**, with the authorizing account added under **Audience** as a
   test user. Test users do not apply in production status;
5. an OAuth client of type **Desktop app**. Loopback ports are then unrestricted, so a
   non-default `--port` needs no console change.

The requested scope is `drive.readonly`; the tool never writes to Drive, so the test media must
be uploaded to the folder by hand.

The authorizing Google account must be able to open the configured folder. `ownerEmail` in the
spec is a contact field and grants nothing: if the folder belongs to a different account, the
authorization still succeeds and the source is simply empty, which only surfaces later as
`no_ready_asset`.

### Loopback ports

`drive-auth` listens on `127.0.0.1:8765` by default and refuses to start if that port is
already taken, because a second listener would split the callback and the run would time out
with no error. Pass `--port <port>` to move it.

STOP if:

- the branch is not `rebuild/headless-agentic-v1`;
- `git status --short` is non-empty before the acceptance run;
- Node is below 22;
- `npm test` fails;
- the release SHA cannot be resolved exactly.

Do not label a local pass as GitHub CI.

## 5. Canonical spec

Create the private host-local spec once:

```bash
cp config/flerdvision.example.json "$FLERDVISION_SPEC"
```

Claude may edit only real owner facts in this file, for example:

- Google Drive folder URL;
- exact Instagram test-account handle;
- channel key/name;
- required format (`reel` first; `trial_reel` only if intentionally tested);
- posting times;
- caption template and hashtags;
- comments/share-to-feed/cross-post settings;
- source matching hints.

Keep:

```json
"ownerEmail": "info@flerdvision.com"
```

For the first real final-action acceptance, the selected test account MUST satisfy the canonical `privateTest` declaration in the spec: private account, zero approved followers, contacts sync off, cross-posting off, test media only.

Do not commit the filled host-local spec when it contains private deployment facts.

## 6. Bootstrap and Drive

Run:

```bash
npm run flerdvision -- bootstrap --spec "$FLERDVISION_SPEC"
```

If the output says source topology is not verified/authenticated, run:

```bash
npm run flerdvision -- drive-auth --spec "$FLERDVISION_SPEC"
```

The human completes the Google authorization in the browser using the intended Flerdvision account associated with `info@flerdvision.com`.

Then repeat:

```bash
npm run flerdvision -- bootstrap --spec "$FLERDVISION_SPEC"
```

Required before continuing:

- source topology is verified;
- the expected source lanes/routes compile;
- no unexplained source-warning changes are ignored.

## 7. One-time social login

For the first Instagram channel, use the exact configured channel key, for example:

```bash
npm run flerdvision -- login \
  --spec "$FLERDVISION_SPEC" \
  --channel instagram-flerdvision
```

The human performs normal login/2FA/challenge steps. Claude waits.

The window is 15 minutes by default and starts when the command does, not when the operator
reaches the machine. Use `--login-timeout <minutes>` (1..120) or
`FLERDVISION_LOGIN_TIMEOUT_MINUTES` when a longer window is needed. The browser opens a profile
that belongs to this identity alone: it carries no bookmarks, extensions or existing sessions,
so being logged in elsewhere in Chrome does not carry over.

A timeout is a failure, never a pass. To tell "nobody logged in" from "logged in but detection
failed" without inspecting the profile by hand, check the recorded session health: an
`AUTH_REQUIRED`/`UNKNOWN` state with no observed handle and a cookie store holding no platform
session cookie means the login never happened.

PASS requires the retained browser profile to prove the exact expected handle. Merely reaching instagram.com is not a pass.

After login:

```bash
npm run flerdvision -- doctor \
  --spec "$FLERDVISION_SPEC" \
  --release-sha "$FLERDVISION_RELEASE_SHA"
```

## 8. Real PREPARE_ONLY acceptance

Run exactly one selected Instagram route first:

```bash
npm run flerdvision -- demo \
  --spec "$FLERDVISION_SPEC" \
  --channel instagram-flerdvision \
  --release-sha "$FLERDVISION_RELEASE_SHA"
```

This must exercise the real path:

- source scan;
- deterministic planning;
- exact browser identity;
- actual media materialization/upload;
- caption/title payload;
- required posting-setting readback;
- autonomous surface discovery;
- three real prepare-only replays;
- final Share/Publish boundary reached;
- **no irreversible click**;
- route qualification persisted for the exact release/surface contract.

Required report conditions:

```text
BOOTSTRAP PASS
INGEST_PLAN PASS
QUALIFY PASS
SCHEDULE PASS
PRIVATE_PUBLISH SKIPPED
success = true
```

A failure is not permission to use a legacy calibration UI.

## 9. Surface drift repair loop

If PREPARE_ONLY fails because Instagram UI changed:

1. save the failing command output and evidence paths;
2. inspect the smallest relevant implementation surface;
3. reproduce with an existing fixture or add a minimal fixture/regression test;
4. patch only on `rebuild/headless-agentic-v1`;
5. run the focused test;
6. run `npm test`;
7. re-read exact branch HEAD;
8. repeat the real PREPARE_ONLY command;
9. require the final action to remain uninvoked.

Use semantic roles/labels/stable attributes and state readback. Do not solve drift by adding brittle account-specific CSS unless no safer deterministic representation exists and the contract remains fail-closed.

If an AI surface-agent helper is used, it may propose locators from sanitized semantic snapshots only. It never receives credentials and never owns final-action authorization.

## 10. One-shot private publish

Only after the PREPARE_ONLY run passes on the exact current SHA may Claude consider the real private test.

Before executing it, Claude MUST obtain an explicit human confirmation in the current session that:

- the selected account is the intended private test account;
- it currently has zero approved followers;
- contacts sync is off;
- Facebook/other cross-posting is off;
- the selected media is harmless test media;
- exactly one private final action is authorized.

Then run:

```bash
npm run flerdvision -- demo \
  --spec "$FLERDVISION_SPEC" \
  --channel instagram-flerdvision \
  --release-sha "$FLERDVISION_RELEASE_SHA" \
  --private-publish
```

The implementation itself must still enforce its one-shot private-E2E gates. Claude must not patch around a failed gate.

PASS requires:

- exactly one selected private-test account;
- technical evidence synchronized;
- privacy attestation accepted;
- retained PREPARE_ONLY reaches the same final boundary;
- durable irreversible-boundary persistence occurs before the final click;
- final action invoked exactly once;
- deterministic reconciliation returns VERIFIED;
- report contains `cleanupRequired: true`.

If the final action was invoked but verification does not become VERIFIED within the bounded verification window, classify the run as uncertain, STOP, and DO NOT repeat `--private-publish`.

## 11. Cleanup

The current headless acceptance intentionally requires the human to delete the verified private test post in Instagram after capturing its verification evidence.

After the human confirms the exact test post was deleted, take the `privatePublish.runId` from the successful report and run:

```bash
npm run flerdvision -- cleanup \
  --spec "$FLERDVISION_SPEC" \
  --release-sha "$FLERDVISION_RELEASE_SHA" \
  --run-id '<PRIVATE_E2E_RUN_ID>' \
  --confirm PRIVATE_E2E_TEST_POST_DELETED \
  --note 'Verified test post manually deleted from the intended private account'
```

Do not run cleanup before deletion. The cleanup command is a durable operator confirmation; it is not an automated Instagram deletion claim.

## 12. Post-acceptance doctor

Run:

```bash
npm run flerdvision -- doctor \
  --spec "$FLERDVISION_SPEC" \
  --release-sha "$FLERDVISION_RELEASE_SHA"
```

Record:

- exact SHA;
- `npm test` result;
- compiled workspace/source warnings;
- exact account identity result;
- route/surface qualification result;
- three prepare-only passes;
- private final-action result, if authorized;
- verification result;
- private cleanup run ID and operator note;
- remaining blockers.

## 13. Autonomous canary — separate authorization

`run-once` and `daemon` are **not** implied by a successful private-E2E run.

They require a separate explicit human authorization after reviewing the private-E2E evidence. Never enable them silently.

If Luca explicitly authorizes one autonomous private-account canary, use the exact selected channel and exact SHA:

```bash
ALLOW_FINAL_PUBLISH=true npm run flerdvision -- run-once \
  --spec "$FLERDVISION_SPEC" \
  --release-sha "$FLERDVISION_RELEASE_SHA" \
  --channel instagram-flerdvision \
  --mode canary \
  --confirm AUTONOMOUS_FINAL_PUBLISH
```

Never use `--mode production` in this acceptance. Do not start `daemon` until a single `run-once` canary has verified successfully and Luca separately authorizes continuous operation.

## 14. Required final report to Luca

Claude returns a compact evidence report in this order:

```text
BRANCH
HEAD_SHA
WORKTREE_CLEAN_BEFORE_REAL_RUN
NPM_TEST
SPEC_PATH
SOURCE_TOPOLOGY
DRIVE_AUTH
ACCOUNT_IDENTITY
PREPARE_ONLY
SURFACE_CONTRACT
PREPARE_ONLY_REPLAYS
PRIVATE_FINAL_ACTION
VERIFICATION
CLEANUP
DOCTOR
FILES_CHANGED_BY_REPAIR
COMMITS_CREATED
EVIDENCE_LEVEL
OPEN_BLOCKERS
NEXT_SAFE_ACTION
```

Never say “fully green”, “done”, “production ready” or “E2E passed” unless the corresponding real evidence in this document actually exists.
