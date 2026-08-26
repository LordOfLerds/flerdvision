# ADR 0006 — Private E2E retained-session final action

Status: Accepted for W8 engineering harness; **not customer-live authorization**.

## Context

W4 deliberately closes a browser session after PREPARE_ONLY reaches the configured final-action boundary. That is safe for reversible acceptance, but a real private E2E publish cannot rebuild the upload after the durable W5 irreversible boundary without introducing an ambiguous second preparation path.

W8 also needs a way to prove the real final action exactly once without turning the ordinary W4 publisher into a live publisher.

## Decision

1. Extract shared reversible preparation into `PlatformPreparationCoordinator`.
2. Represent the prepared browser state as `PreparedPlatformSession` and keep the same browser/page/media/profile lease alive only for the private E2E path.
3. Keep W4 behavior unchanged: PREPARE_ONLY closes/releases the prepared session and has no final-action method.
4. W8 may retain a prepared session after a persisted `PublishAttempt` has reached the final-action boundary.
5. A private final action requires a short-lived, one-shot `E2EPublishPermit` bound to exactly one E2E run, intent, account and release SHA.
6. Permit issuance requires the mandatory W8 gates and at least three successful PREPARE_ONLY replays.
7. Permit consumption happens before delegation to W5 `DurableFinalActionService`.
8. W5 persists irreversible-boundary entry before `RetainedSessionFinalActionInvoker` may click the calibrated final-action element on the **same retained browser session**.
9. The UI click is only action evidence; W5 verification/reconciliation remains the publication truth source.
10. W8 cannot authorize a customer account. W9 remains a separate human-approved canary gate.

## Privacy gate

A “zero-viewer” private E2E claim is allowed only when an operator explicitly attests all of:

- test account is private,
- approved followers = 0,
- contact syncing is off,
- cross-posting is off,
- media is synthetic/test-only.

If any condition is unknown or false, final publish remains blocked or must be treated as potentially visible.

## Failure semantics

- Crash before permit consumption: no irreversible action was authorized.
- Crash after permit consumption but before W5 boundary: permit is spent; operator must issue another permit. Do not infer publication.
- Crash after W5 boundary: W5 marks/reconciles `PUBLISH_UNCERTAIN`; no blind retry.
- Final click succeeds but browser/network disappears: action evidence is insufficient; reconcile through W5.
- Kill switch is checked through the existing W6/W5 path before boundary entry; it does not claim to undo a boundary already crossed.

## Consequences

- The private E2E path is intentionally more cumbersome than ordinary deterministic preparation.
- W4 remains incapable of final publishing.
- Final-action code exists only behind W8 + W5 gates and still cannot create `VerifiedPublication` by itself.
- Real platform selector calibration, login, publish verification, cleanup and failure injection are still required on the intended private test host before W8 is DONE.

## Tests / canary

Required automated proofs:

- permit binding / TTL / one-use,
- privacy attestation fails closed,
- minimum PREPARE_ONLY replay count,
- real Chromium retained-session click against synthetic UI,
- W5 durable boundary precedes click,
- same retained session used for click,
- W4 PREPARE_ONLY remains non-publishing.

Required real acceptance is documented in `docs/17-W8-PRIVATE-E2E.md`. Customer canary remains W9 only.
