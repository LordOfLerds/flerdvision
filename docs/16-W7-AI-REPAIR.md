# W7 — AI incident repair engineering loop

Status: **implemented under local/synthetic verification**.

W7 turns an operational incident into a bounded engineering workflow. It does **not** turn AI into a production operator.

## Pipeline

```text
Incident
  -> IncidentEvidenceBundleBuilder
  -> redaction / binary omission
  -> IncidentEvidenceBundle (append-only)
  -> AiDiagnosisPort
  -> runtime schema validation
  -> RepairPolicy
  -> AiRepairProposalPort (only when policy allows)
  -> RepairPatchValidator
  -> isolated Git worktree + repair branch
  -> fixed repository regression command
  -> fixed full suite command
  -> PREPARE_ONLY replay gate
  -> human review
  -> W8 real-account calibration / canary path
```

## What the model can see

The AI bundle contains sanitized incident context, state history, safe text/DOM/log artifacts, release SHA and adapter version. Secrets, auth headers, cookies, token-like values, email, phone, social handles, home paths and known identifier fields are redacted.

Binary screenshots and trace archives are intentionally **not sent to AI by default**. They remain local evidence. This is stricter than the original plan because screenshot pixels can contain credentials/private customer data that cannot be reliably removed with text regexes. A future explicitly sanitized binary-artifact adapter may opt individual files in.

## AI output is untrusted

Diagnosis/proposal JSON is validated at runtime. Unknown enums, invalid confidence, missing required fields, unsafe diff paths, protected tokens, deletes/renames, binary patches, excessive patches, missing regression tests, or file-set mismatches fail closed.

AI-requested test/shell commands are persisted only as advisory audit data. They are **never executed**. The service runs repository-owned fixed commands.

## Repair classes

### Narrow automatic candidate
- selector config change,
- bounded wait-condition change.

Allowed surface is intentionally narrow (`config/platform-ui*`, repair overrides, W7 tests/fixtures). These changes still cannot reach production directly.

### Engineering review required
- UI workflow config change,
- bounded browser/publisher adapter code change.

These may be prepared on a branch but require engineering review before real-account replay.

### Human-only / prohibited
- authentication / 2FA / platform challenge,
- account identity ambiguity,
- copyright/policy/account warning,
- uncertain publication outcome,
- anything requiring secret access or platform-control bypass.

`PUBLISH_UNCERTAIN` is never repaired by AI and never becomes retryable through W7. W5 reconciliation remains the sole authority.

## Git isolation

`GitRepairWorkspace` creates a new branch in a separate worktree and applies the validated patch there with `git apply --index`. The main worktree is untouched. Patch scope is re-read from Git and compared with the proposal before tests.

## Promotion semantics

W7 can produce a repair **candidate**, never a production release. Gates are append-only:
- POLICY,
- PATCH_SCOPE,
- REGRESSION,
- FULL_SUITE,
- PREPARE_ONLY,
- later HUMAN_REVIEW.

Even all-green W7 gates leave `productionPromotionAllowed=false`. W8 must calibrate against the private/test account before any W9 customer canary.

## CLI

```bash
npm run repair -- show --db runtime/flerdvision.sqlite --incident-id <id>

npm run repair -- bundle \
  --db runtime/flerdvision.sqlite \
  --incident-id <id> \
  --evidence-root artifacts/evidence \
  --release-sha <git-sha> \
  --adapter-version <version>
```

A complete prepare command accepts a **structured AI wrapper executable** that reads the JSON contract on stdin and returns JSON on stdout. The wrapper is an adapter boundary; no production browser/profile directory is exposed to it.

## Environment isolation

The command adapter does not inherit the parent process environment. It passes only `PATH`, `LANG`, and explicitly allowlisted AI-provider authentication variables. Social/account/browser credentials cannot be injected through this adapter.

## Local verification

W7 tests prove:
- migration 7 and append-only repair audit tables,
- secret/PII redaction,
- binary evidence omission,
- evidence-root traversal denial,
- no inherited social secrets in AI child process,
- invalid AI schema rejection,
- repair-policy hard prohibitions,
- protected patch path/token rejection,
- isolated Git worktree behavior,
- regression/full-suite gates,
- synthetic PREPARE_ONLY gate,
- no production promotion,
- `PUBLISH_UNCERTAIN` never reaches proposal generation.

No external Claude/Codex CLI is installed in the current build environment, so provider-specific live model invocation remains deployment integration rather than falsely simulated as production-ready.
