#!/usr/bin/env bash
set -euo pipefail
WORKSPACE_ID="staging"
DISPLAY_NAME="VPS Staging"
RUNTIME_ROOT="${HOME}/.local/share/flerdvision"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHROMIUM="${CHROMIUM_EXECUTABLE_PATH:-}"
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
if [[ "$DRY_RUN" -eq 0 && "$(uname -s)" != "Linux" ]]; then echo "This installer is for Linux VPS hosts." >&2; exit 3; fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
[[ "$NODE_MAJOR" =~ ^[0-9]+$ && "$NODE_MAJOR" -ge 22 ]] || { echo "Node >=22 is required. Pin the runtime before deployment." >&2; exit 4; }
if [[ -z "$CHROMIUM" ]]; then for candidate in /usr/bin/chromium /usr/bin/chromium-browser /usr/bin/google-chrome; do [[ -x "$candidate" ]] && CHROMIUM="$candidate" && break; done; fi
if [[ "$DRY_RUN" -eq 0 && ! -x "$CHROMIUM" ]]; then echo "Chromium/Chrome not found. Install a pinned browser package or pass --chromium PATH." >&2; exit 5; fi
mkdir -p "$RUNTIME_ROOT"; chmod 700 "$RUNTIME_ROOT"
export TZ=Europe/Vienna FLERDVISION_RUNTIME_ROOT="$RUNTIME_ROOT" CHROMIUM_EXECUTABLE_PATH="$CHROMIUM" ALLOW_FINAL_PUBLISH=false
cd "$REPO_ROOT"
echo "[1/5] Build"; npm run build
echo "[2/5] Productization tests"; npm run test:w8a
echo "[3/5] Initialize staging workspace"; npm run workspace -- init --runtime-root "$RUNTIME_ROOT" --workspace-id "$WORKSPACE_ID" --name "$DISPLAY_NAME" --timezone Europe/Vienna >/dev/null
echo "[4/5] Host safety preflight"
if [[ "$DRY_RUN" -eq 0 ]]; then RUNTIME_DIR="$RUNTIME_ROOT" BROWSER_PROFILE_DIR="$RUNTIME_ROOT/workspaces/$WORKSPACE_ID/profiles" EVIDENCE_DIR="$RUNTIME_ROOT/workspaces/$WORKSPACE_ID/evidence" npm run e2e -- preflight; else echo "dry-run: host preflight skipped"; fi
echo "[5/5] Staging host prepared; production promotion remains locked."
cat <<OUT
VPS staging prepared.
Runtime: $RUNTIME_ROOT
Browser: ${CHROMIUM:-<dry-run>}
Bind setup/Ops UIs to localhost or a private Tailscale/WireGuard interface only.
Do not set ALLOW_FINAL_PUBLISH=true outside a one-shot W8 permit flow.
OUT
