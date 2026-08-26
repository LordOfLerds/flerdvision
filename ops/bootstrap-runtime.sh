#!/usr/bin/env bash
set -euo pipefail

RUNTIME_DIR="${RUNTIME_DIR:-./runtime}"
PROFILE_DIR="${BROWSER_PROFILE_DIR:-./profiles}"
EVIDENCE_DIR="${EVIDENCE_DIR:-./artifacts/evidence}"

umask 077
mkdir -p "$RUNTIME_DIR" "$PROFILE_DIR" "$EVIDENCE_DIR"
chmod 700 "$RUNTIME_DIR" "$PROFILE_DIR" "$EVIDENCE_DIR"

printf 'runtime=%s\nprofiles=%s\nevidence=%s\n' "$RUNTIME_DIR" "$PROFILE_DIR" "$EVIDENCE_DIR"
printf 'Permissions initialized with owner-only access.\n'
