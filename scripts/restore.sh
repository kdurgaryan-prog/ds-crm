#!/usr/bin/env bash
# Restore a backup into an EMPTY database. Never run against production without stopping the app first.
# Usage: DATABASE_URL=postgres://… restore.sh path/to/dscrm-YYYYMMDDTHHMMSSZ.dump
set -euo pipefail
FILE="${1:?usage: restore.sh <dump file>}"
export PGOPTIONS="-c app.system=on"  # tables use forced row-level security
COUNT=$(psql "$DATABASE_URL" -Atqc "select count(*) from information_schema.tables where table_schema='public'" || echo 0)
if [[ "$COUNT" != "0" && "${FORCE:-}" != "1" ]]; then echo "Target database is not empty ($COUNT tables). Set FORCE=1 to restore over it." >&2; exit 1; fi
pg_restore --no-owner --clean --if-exists -d "$DATABASE_URL" "$FILE"
echo "Restored $FILE"
