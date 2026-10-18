#!/usr/bin/env bash
# Consistent backup of an openzo data dir: SQLite online backup + workspaces.
#   bash deploy/backup.sh [/path/to/backups]
set -euo pipefail
[ -f /etc/openzo/openzo.env ] && { set -a; . /etc/openzo/openzo.env; set +a; }
DATA="${OPENZO_DATA:-$(cd "$(dirname "$0")/.." && pwd)/data}"
OUT="${1:-/var/backups/openzo}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$OUT"
TMP="$(mktemp -d)"
sqlite3 "$DATA/openzo.db" ".backup '$TMP/openzo.db'"
cp "$DATA/secret" "$TMP/secret" 2>/dev/null || true
tar -C "$DATA" --exclude='users/*/state/.eve/sandbox-cache' -czf "$TMP/users.tar.gz" users
tar -C "$TMP" -czf "$OUT/openzo-$STAMP.tar.gz" .
rm -rf "$TMP"
echo "$OUT/openzo-$STAMP.tar.gz"
