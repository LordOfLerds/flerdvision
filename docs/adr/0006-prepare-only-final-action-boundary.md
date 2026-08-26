# ADR 0006 — PREPARE_ONLY owns a hard final-action boundary

Status: accepted

## Decision

Platform UI preparation and irreversible publishing are separate capabilities.

W4 adapters may navigate, upload media, fill copy, set reversible format options and prove that the final action control is visible. They may not invoke it.

The prepare kernel has two independent protections:
1. `PrepareOnlyPlatformPublisher.invokeFinalAction()` has no implementation and always throws.
2. Reversible click execution dynamically refuses a target when it resolves to the same DOM node as the configured final-action boundary.

## Why

A mode flag alone is insufficient protection against a selector/configuration mistake. The code path itself should lack the irreversible operation during W4.

## Consequences

- platform selector calibration can be rehearsed safely,
- final publishing requires a later explicit implementation/ADR/gate,
- UI config is not trusted merely because it is syntactically valid,
- test-account E2E must prove the boundary on real platform UIs before customer canary.
