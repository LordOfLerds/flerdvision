# ADR 0008 — AI repair receives sanitized evidence and can only prepare branch-scoped changes

Status: accepted in W7.

## Decision

AI is an untrusted engineering dependency. It receives only a sanitized incident bundle, returns schema-validated structured data, and may produce a repair patch only when deterministic `RepairPolicy` allows the incident class.

Patches are validated before application and applied only to an isolated Git worktree/branch. Repository-owned fixed test commands run after application. AI-proposed commands are never executed. W7 cannot merge or promote a repair to production.

`PUBLISH_UNCERTAIN`, authentication/challenge/identity incidents and policy/copyright/account warnings cannot be converted into automated repair/retry behavior by AI.

## Binary evidence

Raw screenshots/traces remain local by default. W7 does not claim that pixel-level secrets can be safely redacted without a dedicated sanitizer. This trades some AI visual context for a stronger no-secret boundary.

## Consequences

- Prompt injection or malformed AI JSON cannot directly change runtime behavior.
- A model cannot weaken verification, reconciliation, kill-switch or final-action safety code through the automatic repair path.
- Main worktree/customer runtime remains untouched by generated patches.
- Real UI proof remains a separate W8 gate.
