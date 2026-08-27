# Definition of Done and Evidence

Flerdvision no longer uses a single undifferentiated word `green` for engineering progress.

A focused test passing proves only the code path exercised by that test. It does **not** prove that the feature is wired into the product, deployable, usable on a real account, or production-ready.

## Evidence ladder

1. `CODE_ON_BRANCH` — implementation is committed to the authoritative Git branch.
2. `LOCAL_FOCUSED_TESTED` — focused tests passed in a developer working environment. This is never sufficient for a completion claim.
3. `FRESH_CLONE_FULL_SUITE` — exact branch HEAD was checked out from scratch, built, and the complete required test suite passed with no required skips.
4. `INTEGRATED_ENTRYPOINT` — feature is reachable through the actual runtime/UI/CLI entrypoint and compatibility/migration plus synthetic end-to-end tests pass.
5. `HOST_VALIDATED` — same release passes install, restart and operation on the named target host.
6. `REAL_SURFACE_VALIDATED` — authorized real social account passes repeated PREPARE_ONLY plus verification-surface checks without unexpected final action.
7. `USER_ACCEPTED` — an independent user can configure and test the same release without developer intervention.
8. `STAGING_VALIDATED` — VPS staging passes soak, restart and failure-injection campaign.
9. `CANARY_VALIDATED` — controlled customer canary passes with zero wrong-account posts, duplicate posts and unverified-success states.

## Hard reporting rules

- `Tests green` must always name the exact test set and environment, e.g. `focused repair tests 65/65 on local working tree`. It must never be shortened to `project green`.
- Work that is not in Git counts as **not delivered**, even if it existed and passed locally earlier.
- A new additive module is not `integrated` until an actual product entrypoint imports/wires it and an integration test proves the path.
- Commit messages are not evidence. Graph files, test output, CI/host run references and persisted E2E evidence are evidence.
- A stage may not be reported `DONE`, `GREEN`, `COMPLETE` or `READY` unless `architecture/completeness-matrix.json` says `green: true` and includes durable evidence for every required gate.
- Real-social completion requires real-account evidence; synthetic DOM cannot substitute for it.
- User-facing completion requires an independent-user workflow; developer-operated setup cannot substitute for it.
- Production readiness requires VPS staging and failure campaign; local Mac success cannot substitute for it.

## Required audit before every milestone report

For every claimed milestone, check forward and backward across:

`Source -> Lane -> Asset -> Route -> Profile -> Plan -> Intent -> Runtime -> Browser -> Publish -> Verify -> DeliveryAggregate -> SourceDisposition -> Attention/Notification -> Operator Recovery -> UI/Audit`.

Also check repository integration:

`Domain -> Store/Migration -> Adapter -> Application service -> real entrypoint -> UI/CLI -> test -> deployment -> real host evidence`.

If a link is missing, the milestone remains partial.
