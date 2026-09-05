#!/usr/bin/env bash
# Flerdvision — switch to one exact immutable release on an installed VPS.
#
# Creates /opt/flerdvision/releases/<sha> if absent, builds/smoke-checks it, then atomically moves
# /opt/flerdvision/current. Persistent config/state are never copied or rewritten.
#
#   sudo deploy/update-release.sh --sha <exact-sha>
#   sudo deploy/update-release.sh --sha <exact-sha> --restart-daemon
#
# Full-suite testing is intentionally NOT repeated here. The SHA must have passed the release gate
# before production deployment. This host only proves that the exact release builds and starts.

set -euo pipefail

PREFIX=/opt/flerdvision
SOURCE_DIR="$PREFIX/source"
RELEASES_DIR="$PREFIX/releases"
CURRENT_LINK="$PREFIX/current"
SERVICE=flerdvision-daemon
APP_USER=flerdvision
RELEASE_ENV=/etc/flerdvision/release.env
PREVIOUS_ENV=/etc/flerdvision/previous-release.env
SHA=""
RESTART=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --sha) SHA="${2:-}"; shift 2;;
    --restart-daemon) RESTART=1; shift;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0;;
    *) echo "Unbekannte Option: $1" >&2; exit 2;;
  esac
done

[[ -n "$SHA" ]] || { echo "Pflicht: --sha <exakte-git-sha>" >&2; exit 2; }
[[ "$(id -u)" -eq 0 ]] || { echo "Als root ausfuehren." >&2; exit 3; }
[[ -d "$SOURCE_DIR/.git" ]] || { echo "Source cache fehlt: $SOURCE_DIR (zuerst deploy/install-vps.sh)." >&2; exit 4; }

as_app() { runuser -u "$APP_USER" -- "$@"; }
as_app_shell() { runuser -u "$APP_USER" -- bash -lc "$1"; }

WAS_ACTIVE=0
if systemctl is-active --quiet "$SERVICE"; then WAS_ACTIVE=1; fi
systemctl stop "$SERVICE" 2>/dev/null || true

CURRENT_SHA=""
if [[ -L "$CURRENT_LINK" && -d "$CURRENT_LINK" ]]; then
  CURRENT_SHA="$(as_app git -C "$CURRENT_LINK" rev-parse HEAD 2>/dev/null || true)"
fi

echo "[1/6] Fetch exact release"
as_app git -C "$SOURCE_DIR" fetch origin --prune
as_app git -C "$SOURCE_DIR" cat-file -e "${SHA}^{commit}" || { echo "SHA $SHA existiert nach fetch nicht." >&2; exit 5; }
FULL_SHA="$(as_app git -C "$SOURCE_DIR" rev-parse "${SHA}^{commit}")"
RELEASE_DIR="$RELEASES_DIR/$FULL_SHA"

if [[ "$CURRENT_SHA" == "$FULL_SHA" ]]; then
  echo "Bereits auf $FULL_SHA; kein Release-Wechsel noetig."
  if [[ "$RESTART" -eq 1 && "$WAS_ACTIVE" -eq 1 ]]; then systemctl start "$SERVICE"; fi
  exit 0
fi

echo "[2/6] Build immutable release $FULL_SHA"
if [[ ! -d "$RELEASE_DIR" ]]; then
  as_app git -C "$SOURCE_DIR" worktree add --quiet --detach "$RELEASE_DIR" "$FULL_SHA"
  as_app_shell "cd '$RELEASE_DIR' && npm ci --silent && npm run build"
else
  READBACK="$(as_app git -C "$RELEASE_DIR" rev-parse HEAD 2>/dev/null || true)"
  [[ "$READBACK" == "$FULL_SHA" ]] || { echo "Existing release dir does not match $FULL_SHA" >&2; exit 6; }
  [[ -f "$RELEASE_DIR/dist/cli/flerdvision.js" ]] || as_app_shell "cd '$RELEASE_DIR' && npm ci --silent && npm run build"
fi
[[ -f "$RELEASE_DIR/dist/cli/flerdvision.js" ]] || { echo "Build artifact missing." >&2; exit 7; }
node --check "$RELEASE_DIR/dist/cli/flerdvision.js" >/dev/null

echo "[3/6] Record previous release"
if [[ -n "$CURRENT_SHA" ]]; then
  printf 'FLERDVISION_PREVIOUS_RELEASE_SHA=%s\n' "$CURRENT_SHA" > "$PREVIOUS_ENV"
  chown root:"$APP_USER" "$PREVIOUS_ENV"
  chmod 640 "$PREVIOUS_ENV"
fi

echo "[4/6] Atomic current switch"
TMP_LINK="$PREFIX/.current-$$"
rm -f "$TMP_LINK"
ln -s "$RELEASE_DIR" "$TMP_LINK"
mv -Tf "$TMP_LINK" "$CURRENT_LINK"
[[ "$(as_app git -C "$CURRENT_LINK" rev-parse HEAD)" == "$FULL_SHA" ]] || { echo "current readback mismatch" >&2; exit 8; }

echo "[5/6] Pin release + refresh generic unit"
printf 'FLERDVISION_RELEASE_SHA=%s\n' "$FULL_SHA" > "$RELEASE_ENV"
chown root:"$APP_USER" "$RELEASE_ENV"
chmod 640 "$RELEASE_ENV"
install -m 644 "$CURRENT_LINK/deploy/flerdvision-daemon.service" /etc/systemd/system/flerdvision-daemon.service
install -m 644 "$CURRENT_LINK/deploy/flerdvision-xvfb.service" /etc/systemd/system/flerdvision-xvfb.service
systemctl daemon-reload

echo "[6/6] Done"
if [[ "$RESTART" -eq 1 ]]; then
  systemctl start "$SERVICE"
  systemctl --no-pager --lines=5 status "$SERVICE" || true
  echo "Daemon gestartet on $FULL_SHA. This flag is only for an already-authorized canary/production release."
else
  echo "Current release is $FULL_SHA. Daemon remains stopped intentionally."
  [[ "$WAS_ACTIVE" -eq 1 ]] && echo "It was active before the update; explicit restart is required after the deployment gate."
fi

echo "Rollback target: ${CURRENT_SHA:-none}. Use deploy/rollback-release.sh."
