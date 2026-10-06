#!/usr/bin/env bash
# Applies every migration to a throwaway local Postgres database (with small
# Supabase stand-ins for auth/storage/roles from scaffold.sql), then runs the
# post-media RLS + constraint checks. Never points at production.
#   Usage: supabase/tests/local-pg/run.sh            (uses sudo -u postgres)
#          PSQL_AS="" PGHOST=... supabase/tests/local-pg/run.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"; mig="$here/../../migrations"
DB="${DB:-bp_media_test}"; AS="${PSQL_AS-sudo -n -u postgres}"
$AS dropdb --if-exists "$DB"; $AS createdb "$DB"
$AS psql -q -X -v ON_ERROR_STOP=1 -d "$DB" -f "$here/scaffold.sql"
for f in "$mig"/*.sql; do
  case "$(basename "$f")" in
    *cron*) echo "skip (needs pg_cron): $(basename "$f")"; continue;;
  esac
  $AS psql -q -X -v ON_ERROR_STOP=1 -d "$DB" -f "$f" >/dev/null || { echo "FAILED applying $(basename "$f")"; exit 1; }
done
echo "all migrations applied"
$AS psql -q -X -v ON_ERROR_STOP=1 -d "$DB" -f "$mig/20261006000004_post_media_uploads.sql" >/dev/null 2>&1 && echo "post_media migration re-applies cleanly (idempotent)" || { echo "FAILED re-applying post_media migration"; exit 1; }
$AS psql -X -v ON_ERROR_STOP=1 -d "$DB" -f "$here/test_media.sql" 2>&1 | grep -E "pass:|FAILED|ERROR|PASSED"
$AS dropdb "$DB"
