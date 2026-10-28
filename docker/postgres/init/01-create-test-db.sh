#!/bin/sh
set -eu
# Executed only when the development PostgreSQL volume is first initialized.
# Keep integration data in a separate database from the local app database.
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set ON_ERROR_STOP=1 <<'SQL'
CREATE DATABASE systemfabric_test OWNER systemfabric;
SQL
