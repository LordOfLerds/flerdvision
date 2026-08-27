#!/usr/bin/env bash
set -euo pipefail
RUNTIME_ROOT="${FLERDVISION_RUNTIME_ROOT:-runtime}"
WORKSPACE_ID="${FLERDVISION_WORKSPACE_ID:-}"
RUN_ID=""
OPERATOR="${USER:-operator}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --runtime-root) RUNTIME_ROOT="$2"; shift 2;;
    --workspace-id) WORKSPACE_ID="$2"; shift 2;;
    --run-id) RUN_ID="$2"; shift 2;;
    --operator) OPERATOR="$2"; shift 2;;
    *) echo "Unknown option: $1" >&2; exit 2;;
  esac
done
[[ -n "$WORKSPACE_ID" && -n "$RUN_ID" ]] || { echo "Usage: sync-host-qualification.sh --workspace-id ID --run-id ID [--runtime-root PATH]" >&2; exit 2; }
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
RELEASE_SHA="$(git rev-parse HEAD)"
[[ -z "$(git status --porcelain)" ]] || { echo "Working tree must be clean before qualification evidence sync." >&2; exit 3; }
EVIDENCE_DIR="$RUNTIME_ROOT/workspaces/$WORKSPACE_ID/evidence/qualification/$RELEASE_SHA/sync"
mkdir -p "$EVIDENCE_DIR"; chmod 700 "$EVIDENCE_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

echo "Synchronizing only gates derivable from durable workspace evidence..."
npm run qualification -- sync-workspace --runtime-root "$RUNTIME_ROOT" --workspace-id "$WORKSPACE_ID" --run-id "$RUN_ID" --operator "$OPERATOR" | tee "$EVIDENCE_DIR/sync-$STAMP.json"
echo
npm run qualification -- checklist --runtime-root "$RUNTIME_ROOT" --run-id "$RUN_ID" | tee "$EVIDENCE_DIR/checklist-$STAMP.json"

echo
cat <<EOF
Evidence sync complete. This command cannot finalize or promote the host.
Reports:
  $EVIDENCE_DIR/sync-$STAMP.json
  $EVIDENCE_DIR/checklist-$STAMP.json

If a gate remains NOT_RUN/FAIL, produce the required real evidence instead of overriding it manually.
EOF
