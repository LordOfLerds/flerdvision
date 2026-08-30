#!/usr/bin/env bash
# Flerdvision — taegliches Backup von SQLite-Datenbanken, Workspace-Config und Browser-Profilen.
#
# - SQLite wird WAL-sicher ueber `sqlite3 ... ".backup ..."` gesichert (nie Datei-Copy einer
#   offenen WAL-DB; src/adapters/storage/sqlite.ts setzt PRAGMA journal_mode=WAL).
# - config/ und profiles/ je Workspace als Tarball. ACHTUNG: profiles/ enthaelt eingeloggte
#   Browser-Sessions (Cookies) — Backups sind Credential-Material, bleiben Mode 600/700 lokal
#   und wandern NIE in Git, Cloud-Sync oder Tickets.
# - Rotation: Backup-Ordner aelter als RETENTION_DAYS werden geloescht (Default 14 Tage).
#
# Aufruf (als User flerdvision, z. B. per systemd-Timer, siehe docs/24-VPS-DEPLOYMENT.md):
#   deploy/backup.sh [--runtime-root /var/lib/flerdvision/runtime] [--backup-root /var/backups/flerdvision] [--retention-days 14]

set -euo pipefail

RUNTIME_ROOT="${FLERDVISION_RUNTIME_ROOT:-/var/lib/flerdvision/runtime}"
BACKUP_ROOT="${FLERDVISION_BACKUP_ROOT:-/var/backups/flerdvision}"
RETENTION_DAYS=14

while [[ $# -gt 0 ]]; do
  case "$1" in
    --runtime-root) RUNTIME_ROOT="$2"; shift 2;;
    --backup-root) BACKUP_ROOT="$2"; shift 2;;
    --retention-days) RETENTION_DAYS="$2"; shift 2;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0;;
    *) echo "Unbekannte Option: $1" >&2; exit 2;;
  esac
done

[[ "$RETENTION_DAYS" =~ ^[0-9]+$ && "$RETENTION_DAYS" -ge 1 ]] || { echo "--retention-days muss eine positive Zahl sein" >&2; exit 2; }
command -v sqlite3 >/dev/null 2>&1 || { echo "sqlite3 fehlt (apt install sqlite3)" >&2; exit 3; }
[[ -d "$RUNTIME_ROOT" ]] || { echo "Runtime-Root existiert nicht: $RUNTIME_ROOT" >&2; exit 4; }

umask 077
STAMP="$(date +%Y%m%d-%H%M%S)"
DEST="$BACKUP_ROOT/$STAMP"
mkdir -p "$DEST"

# Workspace-Registry (JSON, klein, ohne Secrets).
if [[ -f "$RUNTIME_ROOT/registry/workspaces.json" ]]; then
  cp "$RUNTIME_ROOT/registry/workspaces.json" "$DEST/workspaces.json"
fi

shopt -s nullglob
FOUND=0
for workspace_dir in "$RUNTIME_ROOT"/workspaces/*/; do
  workspace_dir="${workspace_dir%/}"
  workspace_id="$(basename "$workspace_dir")"
  FOUND=1

  db="$workspace_dir/database/flerdvision.sqlite"
  if [[ -f "$db" ]]; then
    case "$DEST" in
      *"'"*) echo "Backup-Pfad darf kein einfaches Anfuehrungszeichen enthalten: $DEST" >&2; exit 5;;
    esac
    sqlite3 "$db" ".backup '$DEST/$workspace_id-flerdvision.sqlite'"
    sqlite3 "$DEST/$workspace_id-flerdvision.sqlite" "PRAGMA integrity_check;" | grep -qx "ok" \
      || { echo "Integrity-Check des DB-Backups fehlgeschlagen fuer $workspace_id" >&2; exit 6; }
  fi

  if [[ -d "$workspace_dir/config" ]]; then
    tar -czf "$DEST/$workspace_id-config.tar.gz" -C "$workspace_dir" config
  fi

  # Profile eines gerade LAUFENDEN Browsers koennen inkonsistent sein; Timer daher ausserhalb
  # der Posting-Zeiten legen. Fuer Disaster-Recovery ist ein Ruhe-Snapshot ausreichend.
  if [[ -d "$workspace_dir/profiles" ]]; then
    tar -czf "$DEST/$workspace_id-profiles.tar.gz" -C "$workspace_dir" profiles
  fi
done

if [[ "$FOUND" -eq 0 ]]; then
  echo "Keine Workspaces unter $RUNTIME_ROOT/workspaces — nichts zu sichern." >&2
fi

# Rotation: nur direkte Zeitstempel-Unterordner des Backup-Roots entfernen.
find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -mtime "+$RETENTION_DAYS" -exec rm -rf {} +

echo "Backup fertig: $DEST"
du -sh "$DEST" | awk '{print "Groesse: " $1}'
