#!/usr/bin/env bash
# Flerdvision — atomically roll /opt/flerdvision/current back to an already-built release.
# No network fetch, npm install, config copy or state mutation occurs.
#
#   sudo deploy/rollback-release.sh                  # previous-release.env
#   sudo deploy/rollback-release.sh --sha <exact-sha>
#   sudo deploy/rollback-release.sh --restart-daemon

set -euo pipefail

PREFIX=/opt/flerdvision
RELEASES_DIR="$PREFIX/releases"
CURRENT_LINK="$PREFIX/current"
APP_USER=flerdvision
SERVICE=flerdvision-daemon
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

[[ "$(id -u)" -eq 0 ]] || { echo "Als root ausfuehren." >&2; exit 3; }
if [[ -z "$SHA" ]]; then
  [[ -f "$PREVIOUS_ENV" ]] || { echo "Kein previous-release.env; --sha angeben." >&2; exit 4; }
  # shellcheck disable=SC1090
  source "$PREVIOUS_ENV"
  SHA="${FLERDVISION_PREVIOUS_RELEASE_SHA:-}"
fi
[[ -n "$SHA" ]] || { echo "Rollback-SHA fehlt." >&2; exit 4; }

RELEASE_DIR="$RELEASES_DIR/$SHA"
[[ -d "$RELEASE_DIR" ]] || { echo "Rollback release not installed: $RELEASE_DIR" >&2; exit 5; }
[[ -f "$RELEASE_DIR/dist/cli/flerdvision.js" ]] || { echo "Rollback release has no built CLI." >&2; exit 6; }
READBACK="$(runuser -u "$APP_USER" -- git -C "$RELEASE_DIR" rev-parse HEAD 2>/dev/null || true)"
[[ "$READBACK" == "$SHA" ]] || { echo "Rollback release readback $READBACK != $SHA" >&2; exit 7; }
node --check "$RELEASE_DIR/dist/cli/flerdvision.js" >/dev/null

CURRENT_SHA=""
if [[ -L "$CURRENT_LINK" && -d "$CURRENT_LINK" ]]; then
  CURRENT_SHA="$(runuser -u "$APP_USER" -- git -C "$CURRENT_LINK" rev-parse HEAD 2>/dev/null || true)"
fi
[[ "$CURRENT_SHA" != "$SHA" ]] || { echo "Already on $SHA"; exit 0; }

systemctl stop "$SERVICE" 2>/dev/null || true
TMP_LINK="$PREFIX/.current-$$"
rm -f "$TMP_LINK"
ln -s "$RELEASE_DIR" "$TMP_LINK"
mv -Tf "$TMP_LINK" "$CURRENT_LINK"
printf 'FLERDVISION_RELEASE_SHA=%s\n' "$SHA" > "$RELEASE_ENV"
chown root:"$APP_USER" "$RELEASE_ENV"
chmod 640 "$RELEASE_ENV"
if [[ -n "$CURRENT_SHA" ]]; then
  printf 'FLERDVISION_PREVIOUS_RELEASE_SHA=%s\n' "$CURRENT_SHA" > "$PREVIOUS_ENV"
  chown root:"$APP_USER" "$PREVIOUS_ENV"
  chmod 640 "$PREVIOUS_ENV"
fi
install -m 644 "$CURRENT_LINK/deploy/flerdvision-daemon.service" /etc/systemd/system/flerdvision-daemon.service
install -m 644 "$CURRENT_LINK/deploy/flerdvision-xvfb.service" /etc/systemd/system/flerdvision-xvfb.service
systemctl daemon-reload

echo "Rolled back current: ${CURRENT_SHA:-none} -> $SHA"
echo "Config/secrets/state were not changed."
if [[ "$RESTART" -eq 1 ]]; then
  systemctl start "$SERVICE"
  systemctl --no-pager --lines=5 status "$SERVICE" || true
else
  echo "Daemon remains stopped. Start only if this rollback release is approved for the current host/account state."
fi
