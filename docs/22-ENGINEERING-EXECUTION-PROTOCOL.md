# Engineering Execution Protocol

Status: BINDING for repair work on Flerdvision.

Purpose: prevent long tool loops, hidden local-only work, oversized rewrites, connector drift, and false green claims.

## 1. Small-slice rule

A normal implementation slice may change at most:
- 3 production-code files,
- 2 focused test files,
- 1 documentation/graph file.

If more is required, split the work into multiple safepoints. Cross-cutting migrations are an explicit exception and require a written impact plan before the first write.

## 2. Large-file rule

Do not perform broad full-file rewrites of large existing files merely to add a small feature.

For an existing file larger than roughly 20 KB:
1. prefer extracting a new module/adapter first,
2. then make one small integration edit,
3. fetch/read the exact current blob before writing,
4. verify the resulting branch HEAD immediately after the write.

If a safe minimal edit cannot be made with the available tool, defer the integration rather than reconstructing the whole file from partial snippets.

## 3. Read budget

Use the narrowest read that can answer the current question:
- exact file before repository-wide search,
- line/range read before full-file read,
- one directory listing only when the file name is unknown,
- never repeatedly fetch large directory payloads in a loop.

A tool response that is truncated is not sufficient evidence for a destructive or full-file replacement.

## 4. Tool-failure rule

Never retry the same failed operation indefinitely.

For one failing operation:
1. classify the failure,
2. retry at most once only if the input can materially change,
3. otherwise switch strategy or stop the slice.

Examples of strategy switches:
- contents update -> small additive module,
- large-file rewrite -> extraction + tiny integration,
- connector write anomaly -> read branch HEAD before any further write,
- unavailable CI runner -> record evidence boundary; do not report code tests as CI green.

## 5. Write protocol

Every write slice follows this order:

1. Read authoritative PR/branch HEAD.
2. Read only the exact files required.
3. State the intended forward and reverse workflow impact.
4. Perform the smallest safe write(s).
5. Read PR/branch HEAD again.
6. Read back each materially changed file or relevant lines.
7. Record evidence status.
8. Only then start the next slice.

No reported safepoint may point to a commit that was not read back from the authoritative GitHub branch.

## 6. Connector-drift rule

A returned commit SHA from a write call is not by itself proof that the PR HEAD contains the change.

After every write batch, the authoritative proof is the PR/branch HEAD plus readback of the changed path.

If returned write SHAs and PR HEAD disagree, stop implementation immediately and resolve the drift before continuing.

## 7. Evidence ladder

Use exact evidence labels instead of generic "green":

- CODE_ON_BRANCH
- LOCAL_FOCUSED_TESTED
- FRESH_CLONE_FULL_SUITE
- INTEGRATED_ENTRYPOINT
- HOST_VALIDATED
- REAL_SURFACE_VALIDATED
- USER_ACCEPTED
- STAGING_VALIDATED
- CANARY_VALIDATED

Never promote one evidence level into another by wording.

## 8. Progress reporting

After each safepoint report exactly:
- branch HEAD,
- functionality added,
- files materially changed,
- evidence actually executed,
- open blocker(s),
- next single slice.

Do not report a broad wave complete when only an isolated module or focused test is complete.

## 9. Workflow completeness check

Before a feature can be considered integrated, check all relevant edges:

Source/Drive -> Domain -> Persistence -> Planner -> Intent/Reservation -> Runtime -> UI -> Notification -> Recovery -> Audit -> reverse provenance.

For user-facing configuration also check:

UI edit -> impact preview -> revision-safe persistence -> future-plan invalidation/replanning -> route qualification impact -> committed-history preservation.

Any missing edge remains an explicit open item.

## 10. Safety during repair

Repair work does not loosen existing publish safety.

During the current live freeze:
- no customer publishing,
- no generic SECRET_LIVE button,
- no automatic retry of PUBLISH_UNCERTAIN,
- no unqualified route becomes executable,
- no placeholder platform selector is promoted as calibrated.

## 11. Session-resilience

Prefer code that is committed and read back over local/session-only work.

Do not accumulate a large uncommitted conceptual stack across many turns. A meaningful vertical change must reach an authoritative GitHub safepoint before starting the next unrelated slice.

## 12. Stop conditions

Stop the current slice and report the blocker when any of these occurs:
- authoritative HEAD cannot be established,
- exact source file cannot be read reliably,
- connector returns inconsistent writes twice,
- a required test/runtime dependency is unavailable,
- a change would require reconstructing a large file from truncated output,
- safety semantics are ambiguous.

Stopping cleanly is preferable to continuing with guessed state.
