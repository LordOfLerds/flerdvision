# Flerdvision Finish Line — BINDING

Status: **BINDING on `rebuild/headless-agentic-v1` until issues #4–#7 are closed.**

Purpose: finish the already-working product without reopening architecture or entering another speculative patch loop.

This document does **not** weaken any publishing safety invariant in `AGENTS.md`, `CLAUDE.md` or `docs/23-CLAUDE-REAL-ACCOUNT-ACCEPTANCE.md`. It changes prioritization and repair discipline only.

## 1. Established facts for this phase

Treat these as project state, not as tasks to prove from zero:

- the architecture is substantially implemented;
- the canonical headless entrypoint is `npm run flerdvision -- <command>`;
- real verified posting has already been achieved on Instagram, TikTok and YouTube;
- Drive/source ingestion, deterministic planning, durable attempts, verification/reconciliation, autonomous runtime and Telegram operator messaging exist in the branch;
- the remaining goal is regression closure, one clean all-platform run, Telegram acceptance and promotion to `main`.

Do **not** restart W0–W8, rebuild the architecture, introduce a new control plane, or treat old superseded audit issue #2 as the current backlog.

## 2. Ticket order — no parallel invention

Work in this order only:

1. **#4 FIN-1** — freeze scope and stop the speculative repair loop.
2. **#5 FIN-2** — one clean all-platform autonomous posting run.
3. **#6 FIN-3** — Telegram operator acceptance for that run.
4. **#7 FIN-4** — promote the exact proven branch to `main` and ship.

A later ticket does not justify speculative changes while an earlier ticket is unresolved.

## 3. The anti-loop rule

Before any new code write during finish mode:

1. establish exact branch + HEAD;
2. run/read the current doctor state;
3. rerun the **exact currently failing live step on the existing HEAD**;
4. preserve the actual failing evidence;
5. identify one failure class and one implicated surface;
6. make **one smallest evidence-backed change**;
7. add/update one focused regression test;
8. run the focused test and then `npm test`;
9. read back authoritative branch HEAD;
10. rerun the exact same live step before doing anything else.

Never stack a second speculative fix before the first fix has been rerun live.

### Same-failure budget

For one observed failure class:

- patch 1: allowed;
- patch 2: allowed only if the new live evidence disproves patch 1's model;
- patch 3: **forbidden until a short root-cause report is written from the accumulated evidence**.

The root-cause report must answer:

- what exact state was expected;
- what exact state was observed;
- why the previous two models were wrong;
- what invariant or abstraction is actually missing;
- why the next change fixes the class rather than one screenshot.

This rule exists specifically to stop endless `failure -> plausible patch -> new failure -> plausible patch` churn.

## 4. Scope freeze

Until #7 is closed, do not create or expand:

- new product features;
- new architecture layers;
- broad refactors;
- migrations unrelated to a reproduced finish blocker;
- new AI/agent repair systems;
- new setup/control UIs;
- new notification architecture;
- cleanup-only abstractions;
- speculative platform support beyond the configured shipped routes.

Allowed work is only:

- a currently reproduced live blocker;
- a regression test for that blocker;
- operator-message correction proven wrong in the acceptance run;
- release/promotion work required by #7.

## 5. Protect already-qualified routes

A repair for one route must not disturb another route that already works.

Before changing platform/surface code, explicitly determine whether the changed file contributes to the surface fingerprint or route qualification contract.

If yes:

- state which exact routes become stale;
- do not touch unrelated platforms;
- do not requalify unrelated routes;
- do not move a fix into fingerprinted code when an equivalent non-fingerprinted edge fix is sufficient.

A route that is unqualified or unavailable must not crash-loop the daemon or prevent other qualified routes from running.

## 6. Current execution sequence

On the actual host, use the canonical host-local spec and repository-owned commands. Exact channel keys come from the spec; never guess them in code or docs.

### A. Establish the exact candidate

```bash
git switch rebuild/headless-agentic-v1
git pull --ff-only
git status --short
git rev-parse HEAD
npm test
npm run flerdvision -- doctor --spec "$FLERDVISION_SPEC" --release-sha "$(git rev-parse HEAD)"
```

If tests or doctor expose a current blocker, #4 applies. Do not start architecture work.

### B. Prove Telegram transport before the real wave

```bash
npm run flerdvision -- notify-test --spec "$FLERDVISION_SPEC"
```

The operator must receive the test message before the real wave depends on Telegram.

### C. All-platform autonomous wave

Use the existing `run-once` or `daemon` path with explicit configured channel allowlists and the existing independent publish gate/confirmation. Use the browser mode already proven on the host; do not change it speculatively.

The goal is one intended real post on each selected Instagram, TikTok and YouTube route, each ending in authoritative `VERIFIED` evidence.

If a route fails **before** the irreversible boundary, other qualified routes continue and only that route enters the #4 repair loop.

If a route reaches `PUBLISH_UNCERTAIN`, that route stops. Use read-only `verify`/reconciliation; never issue a second final action for the same uncertain publication.

### D. Telegram acceptance

The same real wave must prove that the operator receives understandable messages for the outcomes. Fix message wording only in the message/renderer layer unless evidence proves publishing logic is implicated.

### E. Final readback

After the wave:

```bash
npm run flerdvision -- doctor --spec "$FLERDVISION_SPEC" --release-sha "$(git rev-parse HEAD)"
git status --short
git rev-parse HEAD
```

Do not call the candidate shipped until #5 and #6 have their real evidence.

## 7. Finish evidence

The branch is ready for #7 only when all are true:

- exact final branch HEAD recorded;
- full `npm test` pass on that HEAD;
- Instagram intended post: `VERIFIED`;
- TikTok intended post: `VERIFIED`;
- YouTube intended post: `VERIFIED`;
- no unresolved `PUBLISH_UNCERTAIN` for the acceptance wave;
- no duplicate post;
- no daemon crash/restart loop;
- Telegram transport test received;
- Telegram real outcome messages received and readable;
- final doctor has no unexplained blocker for the shipped routes;
- worktree clean.

Then stop repairing and execute #7. Do not reopen old waves because the product is already at the finish line.

## 8. End-of-cycle report

After every live retry, report only:

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

No long roadmap. No new backlog. No claim that a historically proven platform is "unimplemented" merely because the latest regression run failed.
