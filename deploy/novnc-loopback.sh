#!/usr/bin/env bash
# Persistent noVNC backend for an authenticated/private outer gateway.
# SECURITY: x11vnc and websockify BOTH bind only 127.0.0.1. There is intentionally no VNC
# password here because the endpoint is not reachable off-host; the required outer HTTPS/tailnet/
# SSO gateway provides authentication. NEVER change these listeners to 0.0.0.0.
set -euo pipefail

DISPLAY_ID="${FLERDVISION_DISPLAY:-:99}"
NOVNC_PORT="${FLERDVISION_NOVNC_PORT:-6080}"
VNC_PORT="${FLERDVISION_VNC_PORT:-5900}"

[[ "$NOVNC_PORT" =~ ^[0-9]+$ ]] || { echo "invalid FLERDVISION_NOVNC_PORT" >&2; exit 2; }
[[ "$VNC_PORT" =~ ^[0-9]+$ ]] || { echo "invalid FLERDVISION_VNC_PORT" >&2; exit 2; }
for bin in x11vnc websockify; do command -v "$bin" >/dev/null 2>&1 || { echo "missing $bin" >&2; exit 3; }; done

X_SOCKET="/tmp/.X11-unix/X${DISPLAY_ID#:}"
[[ -S "$X_SOCKET" ]] || { echo "missing X socket $X_SOCKET" >&2; exit 4; }

NOVNC_WEB=""
for candidate in /usr/share/novnc /usr/share/webapps/novnc; do
  [[ -f "$candidate/vnc.html" ]] && NOVNC_WEB="$candidate" && break
done
[[ -n "$NOVNC_WEB" ]] || { echo "noVNC web root not found" >&2; exit 5; }

X11_PID=""
WEB_PID=""
cleanup() {
  [[ -n "$WEB_PID" ]] && kill "$WEB_PID" 2>/dev/null || true
  [[ -n "$X11_PID" ]] && kill "$X11_PID" 2>/dev/null || true
  wait "$WEB_PID" "$X11_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

x11vnc -display "$DISPLAY_ID" -rfbport "$VNC_PORT" -localhost -forever -shared -nopw -noxdamage -quiet -o /dev/null &
X11_PID=$!
websockify --web="$NOVNC_WEB" "127.0.0.1:$NOVNC_PORT" "127.0.0.1:$VNC_PORT" &
WEB_PID=$!

# If either half dies, tear the other one down so systemd can restart the complete pair.
wait -n "$X11_PID" "$WEB_PID"
exit $?
