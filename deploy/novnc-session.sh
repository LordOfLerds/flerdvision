#!/usr/bin/env bash
# Flerdvision — temporaerer noVNC-Fernbildschirm auf dem bestehenden Xvfb-Display.
#
# Zweck: Bei Session-Verlust pausiert das Konto und der Operator loggt sich DIREKT am VPS neu ein
# (Browser-Profil bleibt am Server). Dieses Skript startet dafuer on-demand x11vnc + noVNC auf dem
# Xvfb-Display :99, erzeugt ein Einmal-Passwort und raeumt nach Ablauf (Default 30 min) oder bei
# Strg-C alles restlos weg. Dauerhaft laeuft hier NICHTS.
#
# Sicherheit: bindet ausschliesslich an 127.0.0.1. Zugriff nur per SSH-Tunnel:
#   ssh -L 6080:127.0.0.1:6080 <operator>@<vps>
# und dann im lokalen Browser die ausgegebene URL oeffnen. Kein Port wird oeffentlich exponiert.
#
# Aufruf (als User flerdvision, waehrend flerdvision-xvfb.service laeuft):
#   deploy/novnc-session.sh [--display :99] [--minutes 30] [--novnc-port 6080] [--vnc-port 5900]

set -euo pipefail

DISPLAY_ID=":99"
MINUTES=30
NOVNC_PORT=6080
VNC_PORT=5900

while [[ $# -gt 0 ]]; do
  case "$1" in
    --display) DISPLAY_ID="$2"; shift 2;;
    --minutes) MINUTES="$2"; shift 2;;
    --novnc-port) NOVNC_PORT="$2"; shift 2;;
    --vnc-port) VNC_PORT="$2"; shift 2;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0;;
    *) echo "Unbekannte Option: $1" >&2; exit 2;;
  esac
done

[[ "$MINUTES" =~ ^[0-9]+$ && "$MINUTES" -ge 1 && "$MINUTES" -le 240 ]] || { echo "--minutes muss 1..240 sein" >&2; exit 2; }

for bin in x11vnc websockify openssl; do
  command -v "$bin" >/dev/null 2>&1 || { echo "Fehlt: $bin (apt install x11vnc novnc websockify openssl)" >&2; exit 3; }
done

X_SOCKET="/tmp/.X11-unix/X${DISPLAY_ID#:}"
[[ -S "$X_SOCKET" ]] || { echo "Kein X-Socket $X_SOCKET — laeuft flerdvision-xvfb.service? (systemctl status flerdvision-xvfb)" >&2; exit 4; }

NOVNC_WEB=""
for candidate in /usr/share/novnc /usr/share/webapps/novnc; do
  [[ -f "$candidate/vnc.html" ]] && NOVNC_WEB="$candidate" && break
done
[[ -n "$NOVNC_WEB" ]] || { echo "noVNC-Webroot (vnc.html) nicht gefunden; apt install novnc" >&2; exit 5; }

PASSWORD="$(openssl rand -base64 18 | tr -dc 'A-Za-z0-9' | head -c 16)"
PASSFILE="$(mktemp /tmp/flerdvision-novnc.XXXXXX)"
chmod 600 "$PASSFILE"
x11vnc -storepasswd "$PASSWORD" "$PASSFILE" >/dev/null 2>&1

X11VNC_PID=""
WEBSOCKIFY_PID=""
cleanup() {
  [[ -n "$WEBSOCKIFY_PID" ]] && kill "$WEBSOCKIFY_PID" 2>/dev/null || true
  [[ -n "$X11VNC_PID" ]] && kill "$X11VNC_PID" 2>/dev/null || true
  rm -f "$PASSFILE"
  echo "noVNC-Session beendet und aufgeraeumt."
}
trap cleanup EXIT INT TERM

x11vnc -display "$DISPLAY_ID" -rfbauth "$PASSFILE" -rfbport "$VNC_PORT" \
  -localhost -forever -shared -noxdamage -quiet -bg -o /dev/null
X11VNC_PID="$(pgrep -n -f "x11vnc -display $DISPLAY_ID" || true)"
[[ -n "$X11VNC_PID" ]] || { echo "x11vnc ist nicht gestartet" >&2; exit 6; }

websockify --web="$NOVNC_WEB" "127.0.0.1:$NOVNC_PORT" "127.0.0.1:$VNC_PORT" >/dev/null 2>&1 &
WEBSOCKIFY_PID=$!
sleep 1
kill -0 "$WEBSOCKIFY_PID" 2>/dev/null || { echo "websockify ist nicht gestartet (Port $NOVNC_PORT belegt?)" >&2; exit 7; }

URL="http://127.0.0.1:${NOVNC_PORT}/vnc.html?autoconnect=1"
cat <<INFO

Temporaerer Fernbildschirm aktiv fuer ${MINUTES} Minuten (Display ${DISPLAY_ID}).

  1) Auf dem eigenen Rechner:  ssh -L ${NOVNC_PORT}:127.0.0.1:${NOVNC_PORT} <operator>@<vps>
  2) Im Browser oeffnen:       ${URL}
  3) Einmal-Passwort:          ${PASSWORD}

Danach z. B. den pausierten Login nachholen:
  set -a; . /etc/flerdvision/flerdvision.env; set +a
  DISPLAY=${DISPLAY_ID} npm run flerdvision -- login --channel <channel-key>

Strg-C beendet die Session sofort.
INFO

# TELEGRAM_PLACEHOLDER: Hier spaeter URL-Hinweis + Einmal-Passwort ueber den durablen
# Notification-Outbox-Pfad an den Operator melden (Bot-Transport ist nie Source of Truth,
# AGENTS.md). Bewusst noch nicht implementiert — kein Secret-Versand ohne eigene Freigabe.

sleep "$((MINUTES * 60))" || true
