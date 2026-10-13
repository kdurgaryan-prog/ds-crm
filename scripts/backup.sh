#!/usr/bin/env bash
# Nightly database backup with optional restore verification.
#   DATABASE_URL        app database (required)
#   BACKUP_DIR          where dumps go (default ./data/backups); mount a separate disk or sync off-site
#   BACKUP_KEEP_DAYS    retention (default 14)
#   BACKUP_ADMIN_URL    a role allowed to CREATE DATABASE, used only for the restore test
# Usage: backup.sh [--verify]
set -euo pipefail
DIR="${BACKUP_DIR:-./data/backups}"; KEEP="${BACKUP_KEEP_DAYS:-14}"
mkdir -p "$DIR"
# Row-level security is forced on business tables; the backup reads them in the internal system context.
export PGOPTIONS="-c app.system=on"
STAMP=$(date -u +%Y%m%dT%H%M%SZ); FILE="$DIR/dscrm-$STAMP.dump"
q() { psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -Atqc "$1"; }
RUN_ID=$(q "insert into backup_runs (file) values ('$FILE') returning id")
fail() { q "update backup_runs set finished_at = now(), ok = false, detail = \$\$${1//\$/}\$\$ where id = $RUN_ID" || true; echo "backup failed: $1" >&2; exit 1; }
trap 'fail "unexpected error on line $LINENO"' ERR

pg_dump "$DATABASE_URL" -Fc --no-owner --enable-row-security -f "$FILE" || fail "pg_dump failed"
SIZE=$(stat -c %s "$FILE" 2>/dev/null || stat -f %z "$FILE")
q "update backup_runs set finished_at = now(), ok = true, size_bytes = $SIZE where id = $RUN_ID"

VERIFIED=false; DETAIL="saved"
if [[ "${1:-}" == "--verify" && -n "${BACKUP_ADMIN_URL:-}" ]]; then
  TMP="dscrm_verify_$(date +%s)"
  psql "$BACKUP_ADMIN_URL" -qc "create database $TMP" >/dev/null
  VURL=$(echo "$BACKUP_ADMIN_URL" | sed -E "s#/([^/?]+)(\?|$)#/$TMP\2#")
  if pg_restore --no-owner -d "$VURL" "$FILE" 2>/tmp/restore.err; then
    WANT=$(q "select count(*) from contacts"); GOT=$(psql "$VURL" -Atqc "select count(*) from contacts")
    if [[ "$WANT" == "$GOT" ]]; then VERIFIED=true; DETAIL="restore test passed ($GOT customers)"; else DETAIL="restore test count mismatch: live $WANT, backup $GOT"; fi
  else DETAIL="restore test failed: $(head -c 300 /tmp/restore.err)"; fi
  psql "$BACKUP_ADMIN_URL" -qc "drop database if exists $TMP" >/dev/null || true
elif [[ "${1:-}" == "--verify" ]]; then DETAIL="saved; restore test skipped (BACKUP_ADMIN_URL not set)"; fi
q "update backup_runs set verified = $VERIFIED, detail = \$\$$DETAIL\$\$ where id = $RUN_ID"
find "$DIR" -name 'dscrm-*.dump' -mtime +"$KEEP" -delete
echo "backup ok: $FILE ($SIZE bytes) — $DETAIL"
