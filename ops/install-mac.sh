#!/usr/bin/env bash
set -euo pipefail
WORKSPACE_ID=""
DISPLAY_NAME=""
RUNTIME_ROOT="${HOME}/Library/Application Support/Flerdvision"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHROMIUM=""
DRY_RUN=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --workspace-id) WORKSPACE_ID="$2"; shift 2;;
    --name) DISPLAY_NAME="$2"; shift 2;;
    --runtime-root) RUNTIME_ROOT="$2"; shift 2;;
    --repo-root) REPO_ROOT="$2"; shift 2;;
    --chromium) CHROMIUM="$2"; shift 2;;
    --dry-run) DRY_RUN=1; shift;;
    *) echo "Unknown option: $1" >&2; exit 2;;
  esac
done
[[ -n "$WORKSPACE_ID" && -n "$DISPLAY_NAME" ]] || { echo "Usage: install-mac.sh --workspace-id ID --name NAME [--runtime-root PATH] [--dry-run]" >&2; exit 2; }
if [[ "$DRY_RUN" -eq 0 && "$(uname -s)" != "Darwin" ]]; then echo "This installer is for macOS; detected $(uname -s)" >&2; exit 3; fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
[[ "$NODE_MAJOR" =~ ^[0-9]+$ && "$NODE_MAJOR" -ge 22 ]] || { echo "Node >=22 is required before installation." >&2; exit 4; }
if [[ -z "$CHROMIUM" ]]; then
  for candidate in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" "/Applications/Chromium.app/Contents/MacOS/Chromium"; do [[ -x "$candidate" ]] && CHROMIUM="$candidate" && break; done
fi
if [[ "$DRY_RUN" -eq 0 && ! -x "$CHROMIUM" ]]; then echo "Google Chrome/Chromium not found. Install it or pass --chromium PATH." >&2; exit 5; fi
mkdir -p "$RUNTIME_ROOT"; chmod 700 "$RUNTIME_ROOT"
export TZ=Europe/Vienna FLERDVISION_RUNTIME_ROOT="$RUNTIME_ROOT" CHROMIUM_EXECUTABLE_PATH="$CHROMIUM" ALLOW_FINAL_PUBLISH=false
cd "$REPO_ROOT"
echo "[1/5] Build"; npm run build
echo "[2/5] Productization tests"; npm run test:w8a
echo "[3/5] Initialize isolated workspace"; npm run workspace -- init --runtime-root "$RUNTIME_ROOT" --workspace-id "$WORKSPACE_ID" --name "$DISPLAY_NAME" --timezone Europe/Vienna >/dev/null
echo "[4/5] Host safety preflight"
if [[ "$DRY_RUN" -eq 0 ]]; then RUNTIME_DIR="$RUNTIME_ROOT" BROWSER_PROFILE_DIR="$RUNTIME_ROOT/workspaces/$WORKSPACE_ID/profiles" EVIDENCE_DIR="$RUNTIME_ROOT/workspaces/$WORKSPACE_ID/evidence" npm run e2e -- preflight; else echo "dry-run: host preflight skipped"; fi
echo "[5/5] Ready"
cat <<OUT
Mac installation prepared.
Workspace: $WORKSPACE_ID
Runtime:   $RUNTIME_ROOT
Chromium:  ${CHROMIUM:-<dry-run>}

Start the private setup UI:
  export TZ=Europe/Vienna
  export FLERDVISION_RUNTIME_ROOT="$RUNTIME_ROOT"
  export CHROMIUM_EXECUTABLE_PATH="$CHROMIUM"
  export FLERDVISION_SETUP_PASSWORD='<choose-local-password>'
  npm run setup-ui -- --runtime-root "$RUNTIME_ROOT" --repo-root "$REPO_ROOT" --chromium "$CHROMIUM"

Then open http://127.0.0.1:8788 locally.
Final publishing remains disabled.
OUT
