#!/usr/bin/env bash
set -euo pipefail
RUNTIME_ROOT="/var/lib/flerdvision"
WORKSPACE_ID="staging"
RUN_ID=""
RELEASE_SHA=""
SERVICE="flerdvision-staging"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --runtime-root) RUNTIME_ROOT="$2"; shift 2;;
    --workspace-id) WORKSPACE_ID="$2"; shift 2;;
    --run-id) RUN_ID="$2"; shift 2;;
    --release-sha) RELEASE_SHA="$2"; shift 2;;
    --service) SERVICE="$2"; shift 2;;
    --repo-root) REPO_ROOT="$2"; shift 2;;
    *) echo "Unknown option: $1" >&2; exit 2;;
  esac
done
[[ -n "$RUN_ID" && -n "$RELEASE_SHA" ]] || { echo "Usage: qualify-vps-service.sh --run-id ID --release-sha SHA [--workspace-id staging]" >&2; exit 2; }
[[ "$(id -u)" -eq 0 ]] || { echo "Run as root; systemd lifecycle evidence requires systemctl/journalctl." >&2; exit 3; }
cd "$REPO_ROOT"
[[ "$(git rev-parse HEAD)" == "$RELEASE_SHA" ]] || { echo "Current Git HEAD does not match qualification release." >&2; exit 4; }
EVIDENCE_DIR="$RUNTIME_ROOT/workspaces/$WORKSPACE_ID/evidence/qualification/$RELEASE_SHA/VPS_STAGING/service"
mkdir -p "$EVIDENCE_DIR"; chmod 700 "$EVIDENCE_DIR"

wait_active(){
  local deadline=$((SECONDS+45))
  while (( SECONDS < deadline )); do
    if systemctl is-active --quiet "$SERVICE"; then return 0; fi
    sleep 1
  done
  systemctl status "$SERVICE" --no-pager || true
  return 1
}
wait_cycle(){
  local before_started="${1:-}" deadline=$((SECONDS+90)) out="$2"
  while (( SECONDS < deadline )); do
    npm run runtime-status -- --runtime-root "$RUNTIME_ROOT" --workspace-id "$WORKSPACE_ID" > "$out.tmp" 2>/dev/null || true
    if node -e '
      const fs=require("fs"),p=process.argv[1],before=process.argv[2];
      try{const x=JSON.parse(fs.readFileSync(p,"utf8")),c=x.runtimeCycles?.latest;if(c&&(!before||new Date(c.startedAt)>new Date(before)))process.exit(0);}catch{}process.exit(1);
    ' "$out.tmp" "$before_started"; then mv "$out.tmp" "$out"; return 0; fi
    sleep 2
  done
  mv "$out.tmp" "$out" 2>/dev/null || true
  return 1
}
record_pass(){
  local gate="$1" summary="$2"; shift 2
  local args=(npm run qualification -- gate --runtime-root "$RUNTIME_ROOT" --run-id "$RUN_ID" --gate "$gate" --passed true --summary "$summary" --operator vps-service-qualifier)
  for artifact in "$@"; do args+=(--artifact "file://$artifact"); done
  "${args[@]}" >/dev/null
}

STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
systemctl start "$SERVICE"
wait_active
systemctl status "$SERVICE" --no-pager > "$EVIDENCE_DIR/service-start.txt"
if ! wait_cycle "" "$EVIDENCE_DIR/runtime-after-start.json"; then
  journalctl -u "$SERVICE" --since "$STARTED_AT" --no-pager > "$EVIDENCE_DIR/journal-start-failure.txt" || true
  echo "Worker became active but produced no durable runtime cycle within 90s." >&2
  exit 5
fi
journalctl -u "$SERVICE" --since "$STARTED_AT" --no-pager > "$EVIDENCE_DIR/journal-start.txt" || true
record_pass SERVICE_LIFECYCLE "Hardened non-root systemd worker started and produced a durable RuntimeCycleReport." "$EVIDENCE_DIR/service-start.txt" "$EVIDENCE_DIR/runtime-after-start.json" "$EVIDENCE_DIR/journal-start.txt"

BEFORE_CYCLE="$(node -e 'const x=require(process.argv[1]);process.stdout.write(x.runtimeCycles.latest.startedAt)' "$EVIDENCE_DIR/runtime-after-start.json")"
cp "$EVIDENCE_DIR/runtime-after-start.json" "$EVIDENCE_DIR/runtime-before-restart.json"
RESTARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
systemctl restart "$SERVICE"
wait_active
if ! wait_cycle "$BEFORE_CYCLE" "$EVIDENCE_DIR/runtime-after-restart.json"; then
  journalctl -u "$SERVICE" --since "$RESTARTED_AT" --no-pager > "$EVIDENCE_DIR/journal-restart-failure.txt" || true
  echo "No new durable cycle observed after restart." >&2
  exit 6
fi
systemctl status "$SERVICE" --no-pager > "$EVIDENCE_DIR/service-after-restart.txt"
journalctl -u "$SERVICE" --since "$RESTARTED_AT" --no-pager > "$EVIDENCE_DIR/journal-restart.txt" || true

node - "$EVIDENCE_DIR/runtime-before-restart.json" "$EVIDENCE_DIR/runtime-after-restart.json" <<'NODE'
const fs=require('fs');
const before=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const after=JSON.parse(fs.readFileSync(process.argv[3],'utf8'));
function fail(msg){console.error(msg);process.exit(1);}
if(!after.runtimeCycles?.latest)fail('after restart has no runtime cycle');
if(new Date(after.runtimeCycles.latest.startedAt)<=new Date(before.runtimeCycles.latest.startedAt))fail('runtime cycle did not advance after restart');
if(before.assets.total>0&&after.assets.total===0)fail('asset runtime state reset after restart');
if(!String(before.dailyPlan.planId).includes(':missing:')&&String(after.dailyPlan.planId).includes(':missing:'))fail('current DailyPlan disappeared after restart');
if(before.sourcePolling?.lastPollAt&&!after.sourcePolling?.lastPollAt)fail('durable source poll state disappeared after restart');
if(after.controlPlane===undefined)fail('control-plane readback missing after restart');
NODE

record_pass RESTART_PERSISTENCE "Worker restart produced a new durable cycle without resetting persisted asset/plan/poll/control state." "$EVIDENCE_DIR/runtime-before-restart.json" "$EVIDENCE_DIR/runtime-after-restart.json" "$EVIDENCE_DIR/service-after-restart.txt" "$EVIDENCE_DIR/journal-restart.txt"

npm run qualification -- checklist --runtime-root "$RUNTIME_ROOT" --run-id "$RUN_ID" | tee "$EVIDENCE_DIR/checklist-after-service-restart.json"
echo "SERVICE_LIFECYCLE and RESTART_PERSISTENCE evidenced. FAILURE_CAMPAIGN and SOAK remain open."
