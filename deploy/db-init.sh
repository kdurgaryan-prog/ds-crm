#!/bin/bash
# Runs once when the database volume is created. The app connects as a NON-superuser so row-level security applies.
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname dscrm <<SQL
create extension if not exists pgcrypto;
create extension if not exists pg_trgm;
create role dscrm_app login password '${APP_DB_PASSWORD}';
alter database dscrm owner to dscrm_app;
alter schema public owner to dscrm_app;
SQL
