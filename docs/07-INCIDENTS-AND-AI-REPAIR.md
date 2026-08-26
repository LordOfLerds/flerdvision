# 07 — Incidents and AI-assisted repair

AI is a diagnostic/engineering accelerator, not an unbounded production operator.

W7 implements this as a bounded, auditable pipeline. See `docs/16-W7-AI-REPAIR.md` and ADR 0008.

## Deterministic layer first

Runtime classifies known failures before AI is involved:
- timeout/network,
- browser crash,
- session expired,
- identity mismatch,
- missing element / UI drift,
- upload rejected,
- policy/copyright/account warning,
- uncertain publish outcome,
- missing source data.

Known safe recoveries may run automatically only before the irreversible boundary.

## Incident bundle

For a technical/UI incident, the W7 bundle builder collects:
- incident kind/severity/status,
- relevant state-transition history,
- human-action audit summary,
- release SHA and adapter version,
- safe text/DOM/log evidence behind an evidence-root allowlist.

Before AI access it redacts token/password/session/cookie/auth-header data, email, phone, social handles, known identifier fields and home paths.

**Raw binary screenshots and trace archives are excluded from AI input by default.** They remain local evidence. A future dedicated binary sanitizer may opt explicitly sanitized screenshots in; W7 does not pretend that text regexes can safely scrub arbitrary screenshot pixels.

## AI role

A Claude/Codex-style adapter may:
1. classify the sanitized incident,
2. explain likely root cause,
3. propose one bounded selector/workflow repair,
4. return a unified diff plus regression test paths,
5. provide confidence/security notes.

AI may **not**:
- solve/bypass CAPTCHA,
- automate 2FA/authentication recovery,
- guess/switch account identity,
- ignore account/copyright/policy warnings,
- free-form click production accounts,
- convert uncertain publish into retry,
- alter verification/reconciliation/final-action/kill-switch safety through the automatic path,
- choose arbitrary shell commands to execute.

## Untrusted-output boundary

All model JSON is runtime-schema validated. The patch is separately validated for path scope, protected tokens, file count/size, regression tests, delete/rename/binary changes and the actual Git changed-file set.

AI-suggested commands are audit-only. W7 executes fixed repository-owned regression/full-suite commands.

## Git isolation

A permitted repair is applied to a separate `repair/...` branch and isolated worktree. The main worktree is never modified by the repair adapter.

## Promotion of a repair

`incident -> sanitized bundle -> diagnosis -> policy -> patch -> regression tests -> full suite -> prepare-only gate -> human review -> W8 private/test account`

Even a fully green W7 result reports `productionPromotionAllowed=false`. Customer rollout remains a W9 concern.

## Prohibited incident classes

`PUBLISH_UNCERTAIN` remains exclusively under W5 reconciliation. Auth/challenge/identity and policy/copyright/account-warning incidents remain human-only/prohibited for automated repair.
