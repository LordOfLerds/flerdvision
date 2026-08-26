# W8 — private/test-account real E2E

Status: **engineering harness implemented; real private-account acceptance still pending**.

W8 is the first wave allowed to touch a real social account, and only a dedicated test account. Customer accounts remain prohibited until W9.

## Required order

1. Host preflight.
2. Register one dedicated test SocialAccount/BrowserIdentity.
3. Human login + 2FA in the normal browser UI.
4. Session health PASS.
5. Exact account identity PASS.
6. Calibrate real platform UI selectors/fingerprint.
7. Run PREPARE_ONLY at least three times.
8. Attest privacy conditions for a zero-viewer publish test.
9. Calibrate final-action boundary without clicking it.
10. Issue one short-lived, one-shot E2E publish permit.
11. Invoke exactly one private test publish on the retained prepared browser session.
12. Reconcile/verify through W5.
13. Human cleanup/delete of the test post and verify cleanup.
14. Run the real-host failure campaign.

## Zero-viewer privacy gate

Flerdvision only permits the strict zero-viewer test claim when an operator attests all of:
- account is private,
- approved followers = 0,
- contact sync is off,
- cross-posting is off,
- media is synthetic/test-only.

If those facts cannot be guaranteed, W8 must remain PREPARE_ONLY or the test must be treated as potentially visible.

## One-shot final-action permit

A permit is bound to:
- one E2E run,
- one PublicationIntent,
- one account,
- one release SHA.

It expires after 30–600 seconds, is stored only as a SHA-256 token hash, and can be consumed once. Issuance requires all mandatory W8 gates plus at least three successful PREPARE_ONLY replays.

Permit consumption occurs before W5's durable irreversible boundary. If the worker crashes between permit consumption and boundary entry, the safe consequence is only that another operator permit is required; the system never assumes a post happened.

## Retained prepared browser session

W4 originally closed the browser after reaching the final-action boundary. That is correct for PREPARE_ONLY but incorrect for a real final action because re-building the upload after boundary entry could create ambiguous behavior.

W8 therefore introduces `PreparedPlatformSession`:

```text
prepare media/copy/UI
  -> retain exact browser session at final button
  -> persist prepared PublishAttempt
  -> issue/consume E2E one-shot permit
  -> W5 persists irreversible boundary
  -> click final button on SAME retained session
  -> close/release session
  -> verify through W5
```

The old W4 publisher still closes the session and still has no final-action method.

## CLI

Host preflight:

```bash
npm run e2e -- preflight
```

Start a test run:

```bash
npm run e2e -- start \
  --run-id e2e-2026-... \
  --account-id test-instagram \
  --platform instagram \
  --release-sha <git-sha> \
  --operator <operator>
```

Privacy attestation:

```bash
npm run e2e -- attest-privacy \
  --run-id <run> \
  --operator <operator> \
  --account-private true \
  --approved-followers 0 \
  --contacts-sync-off true \
  --cross-posting-off true \
  --test-media-only true
```

A final-action permit is intentionally harder to issue:

```bash
npm run e2e -- permit \
  --run-id <run> \
  --intent-id <intent> \
  --release-sha <git-sha> \
  --operator <operator> \
  --confirm PRIVATE_E2E_FINAL_ACTION
```

The returned plaintext token is shown once and must not be committed or logged.

## Current acceptance

Local/synthetic acceptance proves:
- migration 8,
- append-only E2E gate history,
- fail-closed zero-viewer privacy policy,
- one-shot permit issuance/consumption,
- real Chromium retained-session final-click mechanics against synthetic UI,
- durable W5 boundary ordering remains in front of final click,
- host preflight,
- W4 PREPARE_ONLY behavior still passes after the retained-session refactor.

Still required before W8 can be marked DONE:
- intended browser-worker host,
- real private test account login,
- real Instagram selector/UI calibration,
- three real PREPARE_ONLY passes,
- one private publish if zero-viewer conditions are genuinely satisfied,
- real profile verification + cleanup,
- failure injection on the real host.

## Multi-platform campaign extension
The canonical W8 completion criteria now include the matrix in `docs/19-W8-MULTIPLATFORM-E2E-CAMPAIGN.md`. W8 is not complete after a single Instagram publish; it requires all mandatory Instagram/TikTok prepare-only variants plus verified secret-live Instagram normal Reel and TikTok `Only you` runs.
