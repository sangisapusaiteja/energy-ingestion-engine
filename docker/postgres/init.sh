#!/bin/bash
# =============================================================================
# PostgreSQL initialization script
# Runs once when the data volume is empty (first docker-compose up).
# Creates the database and applies the schema.
# =============================================================================
set -euo pipefail

echo "=== Applying energy_engine schema ==="
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
    -f /docker-entrypoint-initdb.d/schema.sql

echo "=== Schema applied successfully ==="
