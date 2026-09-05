# 25 — Product Recovery Graph

Status: **BINDING on `recovery/operator-product-v1` until the recovery work packages below are completed or Luca explicitly changes the target.**

This document supersedes the old finish-line prioritization for this recovery branch. It does **not** weaken the safety invariants in `AGENTS.md`, `docs/22-ENGINEERING-EXECUTION-PROTOCOL.md`, `docs/03-STATE-MACHINES.md`, or the irreversible-boundary / exact-account / reconciliation rules.

## 0. Product target

Flerdvision is one headless social-publishing product with two environments:

- **Luca Acceptance** — real acceptance, controlled live tests, `test-now`, repair qualification.
- **Brother Production** — one production VPS, its own Google Drive authorization, social sessions, Telegram credentials, SQLite state, browser profiles and evidence.

The brother is the production operator. He may manage multiple **customers**. A customer is a business grouping of social channels and schedules inside one installation; it is **not** a separate tenant/runtime/database.

The operator must think in:

`customer -> channel -> video -> time -> status`

The product may internally think in:

`source -> content -> intent -> reservation -> attempt -> evidence -> verified publication`.

Internal route IDs, fingerprints, lease owners, database IDs and qualification artifacts must not leak into normal operator messages.

## 1. Final product graph

```text
                           IMMUTABLE RELEASE
                         Git SHA + ReleaseManifest
                                  |
                       +----------+----------+
                       |                     |
                       v                     v
                LUCA ACCEPTANCE       BROTHER PRODUCTION
                test-now allowed       scheduled production
                       |                     |
                       +----------+----------+
                                  v
                         CANONICAL PRODUCT SPEC
                        flerdvision.json / lock
                                  |
                  +---------------+----------------+
                  |               |                |
                  v               v                v
               Customers       Google Drive      Channels
                  |               |                |
                  |               v                v
                  |          Source topology    Formats/slots
                  |               |                |
                  +---------------+----------------+
                                  v
                           SPEC COMPILER
                                  |
                                  v
                         SOURCE / MEDIA CORE
                     observe -> stabilize -> ready
                                  |
                                  v
                         DETERMINISTIC PLANNER
                                  |
                   +--------------+---------------+
                   |                              |
              scheduled slot                 Luca test-now
                   |                         one-shot slot now
                   +--------------+---------------+
                                  v
                         PublicationIntent
                                  |
                                  v
                     INDEPENDENT ROUTE WORKERS
                  +---------------+---------------+
                  |               |               |
                  v               v               v
              Instagram         TikTok          YouTube
                worker          worker           worker
                  |               |               |
                  +---------------+---------------+
                                  v
                       EXACT ACCOUNT IDENTITY
                                  |
                                  v
                        PREPARE / FINAL BOUNDARY
                                  |
                                  v
                           VERIFICATION V2
                                  |
                  +---------------+----------------+
                  |               |                |
                  v               v                v
               VERIFIED        BLOCKED      PUBLISH_UNCERTAIN
                  |               |                |
                  |               v                v
                  |          Incident/Evidence   reconciliation only
                  |               |
                  |               v
                  |        AUTO DIAGNOSIS COORDINATOR
                  |               |
                  |       +-------+---------+
                  |       |                 |
                  |       v                 v
                  |   safe UI drift      code repair
                  |   candidate          repair branch
                  |       |                 |
                  |   prepare-only       Luca acceptance
                  |       |                 |
                  |       +--------+--------+
                  |                |
                  v                v
                           OPERATOR PROJECTION
                                  |
                                  v
                         UNIFIED TELEGRAM GATEWAY
                  success screenshot / failure evidence /
                  remote-browser link / plan / schedule
```

## 2. Reverse trace graph

Every forward edge must remain reversible enough for support and audit.

```text
Telegram success
 <- VerifiedPublication
 <- VerificationDecision
 <- VerificationEvidence
 <- PublishAttempt
 <- PublicationIntent
 <- ScheduleReservation or TestNowReservation
 <- ContentItem
 <- SourceObservation
 <- Drive object

Telegram failure
 <- OperatorIncidentProjection
 <- Incident
 <- failed route worker phase
 <- evidence snapshot / rolling diagnostic clip
 <- exact intent / account / release SHA
 <- AutoDiagnosis (when permitted)
 <- repair candidate / repair branch if applicable

Daily plan row
 <- customer
 <- channel
 <- account
 <- concrete intent/reservation
 <- source video
 <- schedule policy
```

## 3. Non-negotiable safety invariants retained

The recovery may simplify architecture but must not remove these rules:

1. Exact social-account identity is proven before upload/publish.
2. Irreversible-boundary state is durably persisted before the final UI action.
3. A final click or success toast is never itself publication verification.
4. `PUBLISH_UNCERTAIN` freezes the route and can only go through deterministic reconciliation; no blind retry.
5. Login, password, CAPTCHA, 2FA, account challenge and policy/copyright decisions remain human actions.
6. Kill switches and explicit account/channel allowlists remain effective at claim and immediately before the irreversible boundary.
7. AI receives sanitized evidence only and cannot receive browser profiles, credentials, cookies or raw secrets.
8. AI may not change production code on the brother VPS.
9. AI repair patches never directly promote to production.
10. One browser identity owns one isolated browser profile.
11. Publication success remains evidence-backed and durable.

## 4. Product simplifications

### 4.1 One installation, not a SaaS multi-tenant platform

Keep physical workspace isolation internally because it is already safe and useful, but v1 product behavior is:

```text
one installation = one operator/runtime database
one installation -> many customers -> many channels
```

Do not build tenant provisioning, shared multi-user state, cross-tenant data access or a customer admin SaaS.

### 4.2 Two environments only

Target deployment flow:

```text
CI -> LUCA_ACCEPTANCE -> BROTHER_CANARY -> BROTHER_PRODUCTION
```

The historical `LUCA_MAC -> FABIAN_MAC -> VPS_STAGING -> VPS_PRODUCTION_READY` promotion vocabulary is migration debt and must not drive new code.

### 4.3 One canonical product entrypoint

The intended user-facing surface is `flerdvision` plus Telegram.

Target CLI surface:

```text
flerdvision setup
flerdvision start
flerdvision stop
flerdvision run
flerdvision status
flerdvision plan
flerdvision schedule show
flerdvision schedule add/remove/set
flerdvision capacity set
flerdvision test-now        # Luca Acceptance only
flerdvision doctor          # support/engineering
```

Existing specialist CLIs may survive temporarily as internal engineering tools, but they are not separate product paths.

## 5. Business model addition: Customer

Current channels must gain one business grouping only:

```text
Customer
  key
  name

Customer -> Channel[]
Channel -> Platform + Handle + Formats[]
Format -> Times + Capacity/limits + Posting Settings
```

Rules:

- customer metadata does not affect browser identity, route qualification, verification fingerprint or irreversible safety.
- renaming a customer must not stale platform qualification.
- normal operator plan/status output groups by customer.
- missing content or a blocked route for one customer must not stop other customers.

## 6. Operator UX contract

### 6.1 `/plan` = concrete daily execution

The plan must show what will actually happen today, ordered by local time and grouped by customer:

```text
KUNDE A
12:00 Instagram Reel  "Video X"  VERIFIED/PLANNED/RUNNING
13:00 TikTok          "Video Y"  PLANNED
14:00 YouTube Short   "Video Z"  PLANNED

KUNDE B
10:30 Instagram Reel  "Video Q"  VERIFIED
17:00 TikTok          no ready content
```

The summary must show:

- total posts today;
- verified;
- currently running/verifying;
- remaining;
- blocked/missing content;
- next post with customer + channel + time.

### 6.2 `/zeitplan` / schedule = rules, not today's plan

Show recurring configured times/capacity by customer/channel/format. Changing a schedule must atomically update canonical configuration, validate it and replan only future unbound work.

A pure slot/time/capacity change must not invalidate browser qualification unless it changes a platform posting contract.

### 6.3 Customer views

Target commands:

```text
/kunden
/kunde <customer>
/plan
/zeitplan
/status
/browser
```

Operator output contains customer names, channel display names, platform, video labels and times; not internal IDs.

### 6.4 Remote browser

`FLERDVISION_REMOTE_SCREEN_URL` becomes a first-class operator capability.

Any human-action incident caused by auth/session/challenge must include:

- customer;
- platform/account display name;
- concise reason;
- screenshot when available;
- **clickable remote-browser link**;
- one instruction only;
- automatic continuation expectation after the session becomes healthy.

`/browser` returns account/session status plus the remote-browser link.

Production noVNC must remain protected behind an authenticated/private access layer; never expose an unauthenticated VNC/noVNC endpoint publicly.

## 7. Telegram V2 contract

### 7.1 Success

On a verified publication send:

- customer;
- platform/channel;
- video label;
- local publication time;
- permalink;
- **final screenshot of the finished/live publication**.

Do not send the full browser-run video on success.

### 7.2 Failure under automatic diagnosis

One logical incident = one operator thread/message lifecycle.

Initial projection:

- customer/platform/video;
- failed phase;
- concise human-readable error;
- failure screenshot;
- `Auto-Diagnose: läuft`;
- explicit statement whether other routes continue.

Then edit/update the same incident projection with diagnosis/repair state instead of generating many blocker messages.

### 7.3 Human action

Send immediately only when the operator really must act, e.g. login/2FA/challenge/policy warning.

Include the remote-browser link where appropriate.

### 7.4 Diagnostic video

Evidence recording becomes rolling/bounded:

```text
success -> final screenshot retained; run video disposable
failure -> failure screenshot + optional last ~20-30 s diagnostic clip
```

Telegram media delivery must allow screenshot and diagnostic clip as separate durable delivery parts with individual receipt/retry state. Failure of Telegram must never block publishing.

### 7.5 Root-cause grouping

If one root cause blocks 15 assets, operator output must be one incident:

```text
1 root cause
15 affected videos
1 recommended/automatic action
```

not 15 near-identical blocker alerts.

## 8. Runtime V2 contract

The existing durable source/planner/intent/safety core stays. The orchestration changes.

Target:

```text
Source/Plan Coordinator
  -> queues due intents

Instagram Route Worker
TikTok Route Worker
YouTube Route Worker
```

Each route worker must have:

- end-to-end deadline;
- AbortSignal propagated into browser/network waits where feasible;
- continuous lease heartbeat while long work is active;
- isolated failure state;
- bounded verification policy;
- no ability to stall unrelated route workers.

Acceptance/test mode uses zero artificial launch jitter unless a test explicitly asks for jitter. Production jitter is separately configurable.

## 9. Verification V2 contract

Keep `VerificationEvidence`, `VerificationDecision`, `VerifiedPublication` and reconciliation semantics.

Change platform-specific object discovery, especially YouTube.

Preferred verification order:

1. capture direct permalink/video ID/Studio object identity from the upload/final transition when available;
2. verify that exact object against account + expected copy + bounded time window;
3. fallback to persistent bounded cursor/window search;
4. maintain `VERIFYING` while polling within the configured deadline;
5. deadline without sufficient evidence -> `PUBLISH_UNCERTAIN`.

Do not repair YouTube by repeatedly increasing `postOpenLimit` or editing code during an active acceptance run.

Verification limits/timeouts are runtime policy for a frozen release candidate, not a live code-edit knob.

## 10. Auto Diagnosis V2

The existing AI repair core is retained but changes from a disconnected CLI-only capability into an incident consumer.

Target:

```text
Incident
 -> sanitized evidence bundle
 -> AutoDiagnosisCoordinator
 -> classification
    AUTH/2FA/CHALLENGE/POLICY -> HUMAN ACTION
    PUBLISH_UNCERTAIN         -> reconciliation only
    UI/selector/wait drift    -> safe repair candidate
    CODE BUG                  -> Luca repair branch
```

### Brother Production

Permitted automated actions:

- diagnose;
- summarize root cause;
- create bounded selector/wait/config candidate where current RepairPolicy permits;
- run repository-owned focused/contract tests;
- run PREPARE_ONLY shadow replay;
- pause/resume only the affected route when deterministic gates permit it.

Forbidden:

- modifying the production checkout/code;
- changing safety/verification/reconciliation rules through automated repair;
- blind retries after irreversible uncertainty;
- resolving auth/policy challenges.

### Luca Acceptance / engineering

Code repair flow:

```text
production/acceptance evidence
 -> isolated repair branch
 -> focused regression tests
 -> affected-platform contract tests
 -> Luca live reproduction/retry
 -> one full suite when minting a new release candidate
 -> new immutable SHA
```

The full suite is not the default after every tiny repair.

## 11. Drive onboarding V2

Keep OAuth, source discovery and provider adapters.

Add persistent onboarding state:

```text
SPEC_VALIDATED
 -> OAUTH_URL_ISSUED
 -> DRIVE_CONNECTED
 -> ROOT_ACCESS_CONFIRMED
 -> TOPOLOGY_DISCOVERED
 -> TOPOLOGY_CONFIRMED
 -> ACTIVATION_BASELINE_COMMITTED
 -> SOCIAL_ACCOUNTS_AUTHENTICATED
 -> TELEGRAM_CONFIRMED
 -> READY
```

Requirements:

- authorization URL is always printable/resurfacable;
- remote/VPS instructions are explicit;
- discovered folders are proposed with confidence/reason;
- autonomous production requires one-time confirmed mapping;
- operator explicitly chooses `NEW_ONLY` or intended backlog import baseline;
- no silent root/semantic fallback may activate production routing.

## 12. Test-now contract

`test-now` is **not** a second publisher.

```text
Luca command
 -> select READY asset + allowed channel
 -> TestNowReservation(now)
 -> normal PublicationIntent
 -> normal route worker
 -> normal identity/final-boundary/verification
 -> normal Telegram projection
```

Rules:

- allowed only in Luca Acceptance role/config;
- outside normal slots is allowed;
- still obeys account allowlist, kill switches, idempotency and irreversible safety;
- it cannot bypass `PUBLISH_UNCERTAIN` or route qualification.

## 13. Schedule / capacity mutation contract

CLI and Telegram share one `ScheduleCommandService`.

Supported product operations:

- show schedule;
- add slot;
- remove slot;
- replace a channel/format schedule;
- set per-day capacity where capacity differs from explicit slots;
- pause/resume customer/channel/all.

Mutation workflow:

```text
Operator command
 -> parse customer/channel
 -> impact preview
 -> validate new spec
 -> atomic revision-safe persistence
 -> compile
 -> invalidate/replan future unbound reservations only
 -> preserve committed/running/history
 -> report effective schedule
```

## 14. Keep / Refactor / Delete map

### KEEP — safety/domain core

- `SourceObservation -> ContentItem -> PublicationIntent -> PublishAttempt -> VerificationEvidence -> VerifiedPublication` lineage.
- SQLite durable control/state stores.
- source fingerprints and immutable-media rules.
- deterministic planner/reservations/idempotency.
- BrowserIdentity/profile isolation.
- AccountIdentityGuard.
- Durable final-action service / irreversible-boundary persistence.
- `PUBLISH_UNCERTAIN` + reconciliation.
- kill switches and leases.
- durable notification outbox concept.
- Google Drive provider/token/materialization core.
- existing Instagram/TikTok/YouTube surface capabilities that still pass contract/real acceptance.
- existing AI diagnosis/repair validation and policy boundaries.

### REFACTOR — operative layer

- RuntimeSupervisor composition -> deadline-aware independent route-worker orchestration.
- YouTube/object verification -> direct-ID + bounded cursor/window verification.
- Telegram notification adapter + chat messenger -> one gateway/receipt model.
- operator plan/status -> customer-centric projection.
- AI Repair CLI-only activation -> AutoDiagnosisCoordinator.
- Drive bootstrap -> persistent onboarding workflow.
- deployment surface -> one canonical install/update/rollback path.
- test scripts -> focused/core/platform/full layers.
- spec -> customer dimension + operator schedule/capacity commands.

### DELETE AFTER PARITY — never before proof

Product paths targeted for deletion/archival after replacement acceptance:

- `legacy:control-center`
- `legacy:setup-ui`
- `legacy:ops`
- `legacy:platform-ui`
- `legacy:e2e`
- duplicate old setup/calibration HTTP/UI code only used by those paths;
- obsolete old VPS installer/path once the canonical deploy path proves install/update/rollback;
- obsolete user-facing specialist CLI wrappers after equivalent `flerdvision` commands exist;
- active dependence on W1..W8A test naming after tests are reclassified by subsystem;
- stale finish/handoff/completeness documents as sources of release truth;
- old promotion vocabulary/code that has no remaining runtime use.

Deletion rule:

```text
new path integrated
 -> focused tests
 -> real/host parity where relevant
 -> reference search shows no active dependency
 -> delete old path
 -> readback + tests
```

Never delete safety/domain code merely because an old CLI referenced it.

## 15. Work-package graph

```text
WP0  Recovery truth / CI baseline
 |
 +--> WP1 Product command surface + role model
 |      |
 |      +--> WP2 Customer + schedule/capacity model
 |      |      |
 |      |      +--> WP2b test-now
 |      |
 |      +--> WP7 Drive onboarding V2
 |
 +--> WP3 Runtime worker isolation
 |      |
 |      +--> WP4 Verification V2
 |      |      |
 |      |      +--> WP6 Telegram/operator success projection
 |      |
 |      +--> WP5 Evidence + automatic diagnosis
 |             |
 |             +--> WP6 Telegram/operator incident projection
 |
 +--> WP6b Remote-browser operator access
 |
 +---------------------> WP8 Luca frozen-SHA acceptance
                           |
                           v
                     WP9 Brother canary/productive deployment
                           |
                           v
                     WP10 Legacy deletion + documentation collapse
                           |
                           v
                       RELEASE MAIN
```

## 16. Work packages and exit gates

### WP0 — Recovery truth / deterministic baseline

Actions:

1. establish recovery branch from exact audited SHA;
2. make CI deterministic on a normal runner (including Chromium portability fixture isolation);
3. define focused/core/platform/full test layers;
4. stop full-suite execution after every micro-repair;
5. update agent instructions to bind this recovery graph;
6. protect `main` operationally through PR/CI discipline where repository permissions allow;
7. define generated/authoritative ReleaseManifest source of release evidence.

Exit:

- exact branch SHA;
- current CI/full suite green on that SHA;
- old finish-line instructions no longer conflict with recovery execution;
- no real acceptance while baseline is red.

### WP1 — One product command surface

Actions:

- keep `npm run flerdvision -- <command>` as canonical implementation entrypoint;
- introduce product commands for run/status/plan/schedule/test-now/setup where needed;
- specialist CLIs become internal/support-only;
- add explicit environment role `acceptance | production` or equivalent deterministic gate.

Exit: normal operation no longer requires legacy/specialist product CLIs.

### WP2 — Customer + schedule/capacity

Actions:

- add `Customer` metadata in canonical spec/domain read model;
- channel references customer key;
- update compiler without changing browser-route identity semantics for customer metadata;
- implement `ScheduleCommandService`;
- customer-centric `/plan`, `/zeitplan`, `/kunden`, `/kunde` views;
- schedule mutations preserve committed/running/history and replan only future work.

Exit: operator can see and safely change customer schedules without requalification caused by display/business metadata.

### WP2b — Luca test-now

Actions:

- one-shot reservation now;
- use normal intent and publishing pipeline;
- acceptance-only gate;
- clear Telegram result.

Exit: Luca can intentionally test a selected platform outside configured slots without a parallel publish implementation.

### WP3 — Runtime isolation

Actions:

- deadline-aware route workers;
- continuous heartbeat during long work;
- abort propagation;
- independent platform/route failure containment;
- acceptance jitter zero by default.

Exit: forced YouTube timeout does not prevent a due Instagram/TikTok route from reaching its own terminal state.

### WP4 — Verification V2

Actions:

- capture direct publication object identity where possible;
- exact object verification first;
- bounded persistent fallback search;
- platform-specific timeout policy;
- remove live code-edit dependency on `postOpenLimit`.

Exit: all selected routes can verify on frozen code; timeout becomes deterministic `PUBLISH_UNCERTAIN`, not a code-changing loop.

### WP5 — Evidence + automatic diagnosis

Actions:

- failure evidence contract;
- bounded/rolling screencast artifact;
- incident root-cause grouping;
- wire `AutoDiagnosisCoordinator` to eligible runtime incidents;
- safe config/wait repair path remains gated and prepare-only before activation;
- code bugs create engineering repair work, not production self-modification.

Exit: eligible synthetic/controlled UI drift automatically reaches diagnosis and safe candidate handling without operator engineering commands.

### WP6 — Telegram/operator UX V2

Actions:

- one Telegram gateway for message/photo/video/edit/poll semantics;
- request timeout/Abort;
- durable delivery parts/receipts;
- verified success -> final screenshot + permalink;
- incident -> one evolving projection;
- customer-centric plan/status;
- collapse related blockers.

Exit: operator acceptance proves success screenshot, readable failure, no notification spam, and Telegram outage never blocks publishing.

### WP6b — Remote browser

Actions:

- protected remote-screen endpoint contract;
- `/browser` command;
- remote link on auth/challenge incidents;
- session-health recheck/automatic continuation.

Exit: operator can move from Telegram alert to the correct browser session without SSH command discovery, while remote access remains authenticated/private.

### WP7 — Drive onboarding V2

Actions:

- resumable onboarding state;
- persistent OAuth/setup progress;
- root access confirmation;
- topology proposal and confirmation;
- activation baseline selection;
- readiness projection.

Exit: fresh production installation reaches READY without editing generated route IDs or internal configuration files.

### WP8 — Luca acceptance

Frozen exact SHA; no code changes during the active acceptance candidate.

Acceptance matrix:

- customer grouping and plan clarity;
- slot mutation and replan;
- `test-now` outside slot;
- Instagram VERIFIED;
- TikTok VERIFIED;
- YouTube VERIFIED;
- success Telegram screenshot/permalink;
- controlled pre-boundary failure -> automatic diagnosis;
- auth-required failure -> remote-browser link;
- route failure does not block unrelated routes;
- restart preserves state;
- duplicates = 0;
- wrong-account actions = 0;
- unresolved unverified-success claims = 0.

Exit: USER_ACCEPTED + REAL_SURFACE_VALIDATED on exact SHA.

### WP9 — Brother deployment

Actions:

- one canonical VPS installer;
- one canonical update/rollback path;
- brother-specific Drive/social/Telegram/secrets/state;
- never copy Luca credentials/profile/database;
- systemd startup and health;
- canary then production.

Exit: brother can operate normal production through Drive + Telegram with no engineering CLI for daily use.

### WP10 — Legacy deletion / repo collapse

Only after WP9 parity.

Actions:

- dependency/reference inventory;
- remove legacy UI/product entrypoints;
- remove duplicate installers;
- remove obsolete active docs/state matrices;
- reorganize test commands by subsystem;
- keep historical design decisions in Git history, not active execution path;
- update README/AGENTS/architecture docs to one product truth.

Exit:

```text
one product entrypoint
one setup path
one runtime path
one verification path
one Telegram/operator surface
one release truth
```

## 17. Slice execution rule

Each implementation slice follows `docs/22-ENGINEERING-EXECUTION-PROTOCOL.md`.

Additionally, every slice must declare which work package it advances and which graph edges it changes.

Before write:

```text
WP
CURRENT_HEAD
FORWARD_EDGE_CHANGED
REVERSE_EDGE_CHANGED
QUALIFICATION_IMPACT
SAFETY_IMPACT
DELETE_IMPACT
```

After write:

```text
WP
NEW_HEAD
FILES_CHANGED
EVIDENCE_LEVEL
TESTS_ACTUALLY_RUN
OPEN_BLOCKER
NEXT_SINGLE_SLICE
```

No broad claim such as “WP complete” without its exit gate.

## 18. Immediate execution order

The first concrete recovery sequence is:

```text
1. WP0: bind agents/repo to this recovery graph.
2. WP0: fix deterministic CI portability failure.
3. WP0: introduce focused/platform/core/full test commands without deleting old tests yet.
4. WP3: implement runtime deadline/failure isolation in small slices.
5. WP4: repair YouTube verification architecture on frozen semantics.
6. WP5: wire automatic diagnosis from eligible runtime incidents.
7. WP6: unify Telegram delivery and operator projection.
8. WP1/WP2/WP2b: product commands, customer model, schedules, test-now.
9. WP7/WP6b: onboarding + protected remote-browser UX.
10. WP8: frozen Luca acceptance.
11. WP9: brother production.
12. WP10: delete legacy paths only after product parity.
```

This order deliberately restores deterministic engineering/runtime behavior before adding operator convenience features, while preserving the operator requirements in the target graph from the start.
