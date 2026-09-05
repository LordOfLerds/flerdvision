#!/usr/bin/env bash
# Compatibility shim only. The single canonical VPS installer lives in deploy/install-vps.sh.
# Keep this path temporarily so old notes/scripts fail forward into the new product path; WP10 may
# delete this shim after Brother production parity is proven.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
echo "ops/install-vps.sh is retired; forwarding to deploy/install-vps.sh" >&2
exec "$ROOT/deploy/install-vps.sh" "$@"
