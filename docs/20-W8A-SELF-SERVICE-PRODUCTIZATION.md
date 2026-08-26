# W8A — Self-Service productization and host promotion

## Purpose
W8A closes the gap between a tested engineering repository and a product another user can install, configure and test without editing source code.

## Isolation model
Each workspace owns a physically separate runtime tree:

```text
<runtime-root>/
  registry/workspaces.json
  workspaces/<workspace-id>/
    database/flerdvision.sqlite
    profiles/
    evidence/
    media-cache/
    config/
    logs/
```

The master registry contains workspace and release-qualification metadata only. Social account state, publication state, browser sessions and evidence do not share a database across workspaces.

## Promotion chain
A release is promoted in exactly this order:

1. `LUCA_MAC`
2. `FABIAN_MAC`
3. `VPS_STAGING`
4. `VPS_PRODUCTION_READY`

The qualification service refuses to start a later stage unless the same release SHA passed its predecessor.

### Luca Mac acceptance
Required gates: installer, workspace isolation, core tests, host preflight, self-service UI, demo Drive, browser identity, Instagram prepare-only, TikTok prepare-only.

### Fabian Mac acceptance
Repeats the above on a clean independent machine/workspace and additionally requires the secret E2E case. The point is a genuine unfamiliar-user acceptance, not copying Luca's runtime.

### VPS staging acceptance
Repeats setup and E2E on the 24/7 host and adds failure campaign + restart persistence.

### VPS production-ready
Requires the same release to have passed VPS staging. This state is still not a blanket publish switch; production/customer policies remain separate W9 gates.

## Self-service UI
Start locally:

```bash
export FLERDVISION_SETUP_PASSWORD='choose-a-local-password'
npm run setup-ui -- --runtime-root "$HOME/Library/Application Support/Flerdvision" --chromium "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
```

Default bind: `127.0.0.1:8788`.

The UI can:
- create an isolated workspace,
- store a Drive root-folder mapping (never a Drive token),
- register a social account + isolated browser identity,
- open/close the ordinary platform login browser,
- run the allowlisted Test Lab,
- display workspace storage boundaries.

Passwords/2FA are entered only on the platform's own login UI and are not stored as Flerdvision configuration.

## Test Lab
The initial safe local catalog is:
- core repository suite,
- W8 E2E safety harness,
- host preflight.

The runner maps test IDs to fixed repository commands. Arbitrary commands supplied by a user, browser form or AI output are not executable.

Real platform prepare-only tests are added to the Test Lab only after W8 selector calibration on Luca's Mac; they remain non-publishing until one-shot E2E permits are explicitly issued.

## Installers
### macOS

```bash
./ops/install-mac.sh --workspace-id luca --name "Luca"
```

Run the same installer on Fabian's Mac with a different workspace name/id. The installer builds, runs W8A tests, initializes private runtime directories and runs host preflight. It never enables final publishing.

### VPS

```bash
./ops/install-vps.sh --workspace-id staging --name "VPS Staging"
```

The VPS installer is staging-first. It does not install unpinned dependencies automatically and does not promote a release to production-ready.

## External execution boundary
The repository can prepare and validate these installers in the build environment. Actual `LUCA_MAC`, `FABIAN_MAC` and `VPS_STAGING` qualification evidence must be generated on those real hosts; build-container tests must not be relabeled as host acceptance.
