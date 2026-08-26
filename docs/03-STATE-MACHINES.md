# 03 — State machines

## Content lifecycle

```text
OBSERVED
  -> ACCEPTED
  -> PLANNED
  -> READY
  -> SCHEDULED
  -> IN_PROGRESS
  -> COMPLETED

Any pre-publish state -> BLOCKED
Any terminal operator rejection -> REJECTED
```

`COMPLETED` means every required publication intent reached a terminal success state or an explicit policy-defined waiver exists.

## Publication intent lifecycle

```text
PLANNED
 -> READY
 -> SCHEDULED
 -> PREPARING
 -> PUBLISHING
 -> VERIFYING
 -> VERIFIED

PUBLISHING/VERIFYING -> PUBLISH_UNCERTAIN
recoverable failure -> RETRY_WAIT -> READY
risk/identity/auth/policy problem -> BLOCKED
explicit skip -> WAIVED
```

### PUBLISH_UNCERTAIN rule

`PUBLISH_UNCERTAIN` is a safety state, not an error convenience.

When an irreversible click may have succeeded but proof is missing:
1. do **not** click publish again,
2. run reconciliation/verifier strategies,
3. only after positive evidence of absence may policy return the intent to `READY`,
4. otherwise escalate.

## Session lifecycle

```text
UNKNOWN -> HEALTHY
UNKNOWN/HEALTHY -> AUTH_REQUIRED
HEALTHY -> WARNING
HEALTHY -> BROKEN
AUTH_REQUIRED/WARNING/BROKEN -> HUMAN_ACTION_REQUIRED
human recovery -> HEALTHY
```

CAPTCHA, 2FA, password changes, account warnings and policy/copyright warnings are never "self-healed" by free-form AI.
