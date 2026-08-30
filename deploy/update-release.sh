#!/usr/bin/env bash
# Flerdvision — sauberes Release-Update auf eine exakte, gepinnte Git-SHA.
#
# Ablauf: Daemon stoppen -> fetch -> checkout <SHA> (detached) -> npm ci -> npm test (enthaelt
# build) -> Release-SHA nach /etc/flerdvision/release.env pinnen. Bei rotem Test bricht das
# Skript ab und laesst den Daemon GESTOPPT; die alte SHA bleibt in release.env gepinnt.
#
# QUALIFIKATIONSLEITER (AGENTS.md, docs/23): Eine neue SHA ist auf diesem Host NICHT qualifiziert,
# nur weil die Tests gruen sind. Nach jedem Update gilt, bevor der Daemon wieder laeuft:
#   1. PREPARE_ONLY-Qualifikation auf exakt dieser SHA (demo ohne --private-publish),
#   2. falls die Leiter es verlangt: private E2E laut docs/23 Abschnitt 10,
#   3. erst dann Daemon starten.
# Darum startet dieses Skript den Daemon standardmaessig NICHT neu; --restart-daemon ist fuer den
# Operator NACH erledigter Qualifikation.
#
# Aufruf (als root):
#   deploy/update-release.sh --sha <exakte-git-sha> [--restart-daemon] [--app-dir /opt/flerdvision/app] [--service flerdvision-daemon] [--app-user flerdvision]

set -euo pipefail

APP_DIR="/opt/flerdvision/app"
SERVICE="flerdvision-daemon"
APP_USER="flerdvision"
RELEASE_ENV="/etc/flerdvision/release.env"
SHA=""
RESTART=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --sha) SHA="$2"; shift 2;;
    --restart-daemon) RESTART=1; shift;;
    --app-dir) APP_DIR="$2"; shift 2;;
    --service) SERVICE="$2"; shift 2;;
    --app-user) APP_USER="$2"; shift 2;;
    --release-env) RELEASE_ENV="$2"; shift 2;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0;;
    *) echo "Unbekannte Option: $1" >&2; exit 2;;
  esac
done

[[ -n "$SHA" ]] || { echo "Pflicht: --sha <exakte-git-sha> (kein Branch-Name, kein Tag)" >&2; exit 2; }
[[ "$(id -u)" -eq 0 ]] || { echo "Als root ausfuehren (systemctl + $RELEASE_ENV)." >&2; exit 3; }
[[ -d "$APP_DIR/.git" ]] || { echo "Kein Git-Repo unter $APP_DIR" >&2; exit 4; }

as_app() { runuser -u "$APP_USER" -- "$@"; }

echo "[1/7] Fetch"
as_app git -C "$APP_DIR" fetch origin --prune

as_app git -C "$APP_DIR" cat-file -e "${SHA}^{commit}" \
  || { echo "SHA $SHA existiert nach fetch nicht in $APP_DIR" >&2; exit 5; }
FULL_SHA="$(as_app git -C "$APP_DIR" rev-parse "${SHA}^{commit}")"

WAS_ACTIVE=0
if systemctl is-active --quiet "$SERVICE"; then WAS_ACTIVE=1; fi
echo "[2/7] Daemon stoppen (war aktiv: $WAS_ACTIVE)"
systemctl stop "$SERVICE" 2>/dev/null || true

echo "[3/7] Checkout $FULL_SHA (detached)"
DIRTY="$(as_app git -C "$APP_DIR" status --porcelain)"
[[ -z "$DIRTY" ]] || { echo "Arbeitsbaum unter $APP_DIR ist nicht sauber — erst klaeren, nichts wird verworfen:" >&2; echo "$DIRTY" >&2; exit 6; }
as_app git -C "$APP_DIR" checkout --detach "$FULL_SHA"

echo "[4/7] npm ci"
as_app env HOME="$(getent passwd "$APP_USER" | cut -d: -f6)" npm --prefix "$APP_DIR" ci

echo "[5/7] npm test (voller Suite-Lauf inkl. Build)"
if ! as_app env HOME="$(getent passwd "$APP_USER" | cut -d: -f6)" TZ=Europe/Vienna npm --prefix "$APP_DIR" test; then
  cat >&2 <<'RED'

================= TEST ROT — UPDATE ABGEBROCHEN =================
Der Daemon bleibt GESTOPPT. Die vorherige Release-SHA bleibt in
release.env gepinnt. Fehler-Output oben aufbewahren (Evidence),
kleinste implicierte Stelle reparieren, Regressionstest ergaenzen
(docs/22-ENGINEERING-EXECUTION-PROTOCOL.md), dann Update mit der
neuen SHA wiederholen. NICHT den alten Stand blind neu starten,
ohne zu wissen, warum die neue SHA rot ist.
=================================================================
RED
  exit 7
fi

READBACK="$(as_app git -C "$APP_DIR" rev-parse HEAD)"
[[ "$READBACK" == "$FULL_SHA" ]] || { echo "Readback-HEAD $READBACK != erwartete SHA $FULL_SHA" >&2; exit 8; }

echo "[6/7] Release-SHA pinnen: $RELEASE_ENV"
umask 077
printf 'FLERDVISION_RELEASE_SHA=%s\n' "$FULL_SHA" > "$RELEASE_ENV"
chown root:"$APP_USER" "$RELEASE_ENV" 2>/dev/null || true
chmod 640 "$RELEASE_ENV"

echo "[7/7] Abschluss"
if [[ "$RESTART" -eq 1 ]]; then
  systemctl start "$SERVICE"
  systemctl --no-pager --lines=5 status "$SERVICE" || true
  echo "Daemon neu gestartet auf $FULL_SHA — nur zulaessig, wenn diese SHA bereits qualifiziert ist."
else
  cat <<LADDER

Update auf $FULL_SHA ist gebaut und getestet. Daemon ist GESTOPPT (Absicht).

QUALIFIKATIONSLEITER vor dem Neustart (docs/23, AGENTS.md):
  1. set -a; . /etc/flerdvision/flerdvision.env; . $RELEASE_ENV; set +a
  2. PREPARE_ONLY auf exakt dieser SHA (kein --private-publish):
       cd $APP_DIR && DISPLAY=:99 npm run flerdvision -- demo --channel <key> --release-sha \$FLERDVISION_RELEASE_SHA
     Erwartet: BOOTSTRAP/INGEST_PLAN/QUALIFY/SCHEDULE PASS, PRIVATE_PUBLISH SKIPPED, success=true.
  3. Falls die Leiter es fuer dieses Release verlangt: private E2E laut docs/23 Abschnitt 10
     (separate menschliche Freigabe, one-shot).
  4. Erst danach: systemctl start $SERVICE   (oder dieses Skript mit --restart-daemon)
LADDER
  if [[ "$WAS_ACTIVE" -eq 1 ]]; then
    echo "Hinweis: der Daemon lief vor dem Update und wurde bewusst nicht wieder gestartet."
  fi
fi
