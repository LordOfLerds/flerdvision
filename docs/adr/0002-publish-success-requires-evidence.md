# ADR 0002 — Publish success requires evidence

Status: Accepted

Decision: A browser action or platform success toast is not sufficient to create a `VerifiedPublication`.

Reason: Network/browser failure immediately after an irreversible publish action can create duplicate posts if the system retries blindly.

Consequence: `PUBLISH_UNCERTAIN` is first-class and verifiers/reconciliation are mandatory before customer rollout.
