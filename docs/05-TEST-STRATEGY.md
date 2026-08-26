# 05 — Test strategy

No customer account is a test environment.

## Layer 1 — Pure domain tests
- state transitions,
- idempotency keys,
- scheduling windows,
- daily caps/spacing,
- evidence quorum,
- forward/backward traceability.

## Layer 2 — Adapter contract tests
Every ingress/publisher/verifier/notification adapter runs the same contract suite against fixtures.

## Layer 3 — Captured UI fixtures
Use saved sanitized HTML/accessibility snapshots and Playwright traces to test selectors and decision logic without a live platform.

## Layer 4 — Live read-only smoke
On a real test account:
- session health,
- correct account identity,
- open upload UI,
- choose a local fixture,
- fill non-destructive fields,
- STOP before the irreversible publish action.

This should run often.

## Layer 5 — Private test-account E2E
Requirement: **nobody may see the test content**.

Safest policy:
- dedicated private test account,
- zero approved followers,
- contact syncing disabled,
- test asset with no customer data,
- normal private-account post only,
- verify publication through the logged-in profile,
- clean up immediately after evidence capture.

Do not use a Trial Reel for this privacy requirement: Trial Reels are designed to expose content beyond the normal follower audience and therefore conflict with "nobody may see it".

If the user's personal account cannot guarantee zero viewers, the E2E must stop before final publish.

## Layer 6 — Failure injection
Automate:
- browser killed before upload,
- browser killed immediately after final click,
- network loss,
- stale session,
- wrong account identity,
- missing source media,
- duplicate source observation,
- delayed verification,
- selector/UI drift,
- notification sink failure,
- DB restart.

The critical assertion is: no lost intent, no accidental duplicate, uncertainty is preserved.

## Layer 7 — Canary
After all go-live gates:
1. one approved customer creator,
2. one account,
3. one normal low-risk post,
4. human observer present,
5. compare automated evidence with platform state,
6. 24h incident review,
7. increase exposure only after clean result.
