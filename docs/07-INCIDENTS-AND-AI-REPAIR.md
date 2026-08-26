# 07 — Incidents and AI-assisted repair

AI is a diagnostic/engineering accelerator, not an unbounded production operator.

## Deterministic layer first

Runtime classifies known failures before AI is involved:
- timeout/network,
- browser crash,
- session expired,
- identity mismatch,
- missing element,
- upload rejected,
- policy/copyright/account warning,
- uncertain publish outcome,
- missing source data.

Known safe recoveries may run automatically (e.g. browser restart before irreversible action).

## Incident bundle

For an unknown UI/technical incident, collect:
- job/intent IDs,
- state-transition history,
- redacted screenshot,
- redacted accessibility/DOM snapshot,
- Playwright trace,
- console/browser logs,
- last safe action list,
- current URL/page identity,
- release SHA and adapter version.

Secrets/cookies/password fields must be excluded before AI access.

## AI role

Claude/Codex-style agent may:
1. classify the incident,
2. explain likely root cause,
3. propose selector/workflow changes,
4. create a code patch/branch,
5. add regression fixtures/tests,
6. produce a repair confidence report.

AI may **not**:
- solve/bypass CAPTCHA,
- enter 2FA secrets without a human,
- ignore account/copyright/policy warnings,
- switch accounts based on guesswork,
- perform free-form production clicks,
- convert uncertain publish into retry without reconciliation.

## Promotion of a repair

`incident -> diagnosis -> patch -> automated tests -> prepare-only live test -> canary -> production`

For a small class of pre-approved selector fallbacks, runtime can choose among deterministic selector candidates. New behavior still belongs in Git after the incident.
