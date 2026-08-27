#!/usr/bin/env bash
set -euo pipefail
WORKSPACE_ID=""
DISPLAY_NAME=""
RUNTIME_ROOT="${HOME}/Library/Application Support/Flerdvision"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHROMIUM=""
FFPROBE=""
DRY_RUN=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --workspace-id) WORKSPACE_ID="$2"; shift 2;;
    --name) DISPLAY_NAME="$2"; shift 2;;
    --runtime-root) RUNTIME_ROOT="$2"; shift 2;;
    --repo-root) REPO_ROOT="$2"; shift 2;;
    --chromium) CHROMIUM="$2"; shift 2;;
    --ffprobe) FFPROBE="$2"; shift 2;;
    --dry-run) DRY_RUN=1; shift;;
    *) echo "Unknown option: $1" >&2; exit 2;;
  esac
done
[[ -n "$WORKSPACE_ID" && -n "$DISPLAY_NAME" ]] || { echo "Usage: install-mac.sh --workspace-id ID --name NAME [--runtime-root PATH] [--chromium PATH] [--ffprobe PATH] [--dry-run]" >&2; exit 2; }
if [[ "$DRY_RUN" -eq 0 && "$(uname -s)" != "Darwin" ]]; then echo "This installer is for macOS; detected $(uname -s)" >&2; exit 3; fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
[[ "$NODE_MAJOR" =~ ^[0-9]+$ && "$NODE_MAJOR" -ge 22 ]] || { echo "Node >=22 is required before installation." >&2; exit 4; }
if [[ -z "$CHROMIUM" ]]; then
  for candidate in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" "/Applications/Chromium.app/Contents/MacOS/Chromium"; do [[ -x "$candidate" ]] && CHROMIUM="$candidate" && break; done
fi
if [[ -z "$FFPROBE" ]]; then
  for candidate in "/opt/homebrew/bin/ffprobe" "/usr/local/bin/ffprobe" "/usr/bin/ffprobe"; do [[ -x "$candidate" ]] && FFPROBE="$candidate" && break; done
  if [[ -z "$FFPROBE" ]] && command -v ffprobe >/dev/null 2>&1; then FFPROBE="$(command -v ffprobe)"; fi
fi
if [[ "$DRY_RUN" -eq 0 && ! -x "$CHROMIUM" ]]; then echo "Google Chrome/Chromium not found. Install it or pass --chromium PATH." >&2; exit 5; fi
if [[ "$DRY_RUN" -eq 0 && ! -x "$FFPROBE" ]]; then echo "ffprobe not found. Install ffmpeg (for example via Homebrew) or pass --ffprobe PATH." >&2; exit 6; fi
mkdir -p "$RUNTIME_ROOT"; chmod 700 "$RUNTIME_ROOT"
export TZ=Europe/Vienna FLERDVISION_RUNTIME_ROOT="$RUNTIME_ROOT" CHROMIUM_EXECUTABLE_PATH="$CHROMIUM" FFPROBE_EXECUTABLE_PATH="$FFPROBE" ALLOW_FINAL_PUBLISH=false
cd "$REPO_ROOT"
RELEASE_SHA="$(git rev-parse HEAD 2>/dev/null || true)"
[[ -n "$RELEASE_SHA" ]] || { echo "Repository HEAD could not be resolved; use a real Git checkout." >&2; exit 7; }

echo "[1/6] Build"; npm run build
echo "[2/6] Complete repository test suite"; npm test
echo "[3/6] Initialize isolated workspace"; npm run workspace -- init --runtime-root "$RUNTIME_ROOT" --workspace-id "$WORKSPACE_ID" --name "$DISPLAY_NAME" --timezone Europe/Vienna >/dev/null
echo "[4/6] Host safety preflight"
if [[ "$DRY_RUN" -eq 0 ]]; then
  RUNTIME_DIR="$RUNTIME_ROOT" BROWSER_PROFILE_DIR="$RUNTIME_ROOT/workspaces/$WORKSPACE_ID/profiles" EVIDENCE_DIR="$RUNTIME_ROOT/workspaces/$WORKSPACE_ID/evidence" npm run e2e -- preflight
else
  echo "dry-run: host preflight skipped"
fi
echo "[5/6] Enforce live freeze"
[[ "${ALLOW_FINAL_PUBLISH:-false}" != "true" ]] || { echo "ALLOW_FINAL_PUBLISH must remain false." >&2; exit 8; }
echo "[6/6] Integration host prepared"

cat <<OUT
Mac integration host prepared.
Workspace: $WORKSPACE_ID
Runtime:   $RUNTIME_ROOT
Release:   $RELEASE_SHA
Chromium:  ${CHROMIUM:-<dry-run>}
ffprobe:   ${FFPROBE:-<dry-run>}

A) First-time onboarding (source + browser profile/channel discovery once calibration is available):
  export TZ=Europe/Vienna
  export FLERDVISION_RUNTIME_ROOT="$RUNTIME_ROOT"
  export CHROMIUM_EXECUTABLE_PATH="$CHROMIUM"
  export FFPROBE_EXECUTABLE_PATH="$FFPROBE"
  export ALLOW_FINAL_PUBLISH=false
  export FLERDVISION_SETUP_PASSWORD='<choose-local-password>'
  npm run setup-ui -- --runtime-root "$RUNTIME_ROOT" --chromium "$CHROMIUM"

B) Product Control Center:
  export FLERDVISION_CONTROL_PASSWORD='<choose-local-password>'
  export FLERDVISION_RELEASE_SHA="$RELEASE_SHA"
  npm run control-center -- --runtime-root "$RUNTIME_ROOT" --workspace-id "$WORKSPACE_ID" --release-sha "$RELEASE_SHA"

C) R0 runtime in a second terminal (source/planning/recovery/notifications active; final publish physically frozen):
  export FLERDVISION_RELEASE_SHA="$RELEASE_SHA"
  npm run runtime -- --runtime-root "$RUNTIME_ROOT" --workspace-id "$WORKSPACE_ID" --interval-seconds 60

Then use Control Center in this order:
  Sources: choose/capture NEW_ONLY baseline -> Scan now -> confirm assets/readiness
  Channels: open isolated Login/2FA browser if needed
  Programs: map Lane -> Account -> PostingProfile -> Rhythm/Calendar
  Test Lab: SOURCE/SESSION/IDENTITY/SURFACE; PREPARE_ONLY only when the real host adapter is calibrated

Final publishing remains disabled. Passing this installer is evidence for build/full-suite/host-preflight only; it is NOT real-social or Luca-Mac acceptance by itself.
OUT
