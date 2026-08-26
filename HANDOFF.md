# HANDOFF — current repository state

## Current phase
W0 — canonical model and architecture scaffold.

## Implemented
- architecture graph and reverse-trace model,
- domain data contracts,
- publication state machine,
- hard publish gate,
- verification policy skeleton,
- in-memory publisher/verifier fakes,
- tests proving prepare-only cannot publish and missing evidence becomes uncertainty,
- first-time setup/test/go-live/AI-repair plans.

## Intentionally not implemented yet
- Google Drive API/connector adapter,
- real Playwright platform adapters,
- persistent SQLite repository,
- existing bot integration,
- remote browser/VNC operational tooling,
- final-publish capability on any real account.

These are blocked by design until their preceding wave contracts/tests exist.

## Next implementation order
W1 Durable control plane -> W2 ingress/disposition -> W3 browser identities -> W4 PREPARE_ONLY adapters.

## Safety
Do not enable customer publishing during W0-W8. Follow `docs/06-GO-LIVE-GATES.md`.
