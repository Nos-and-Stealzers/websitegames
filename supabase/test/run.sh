#!/usr/bin/env bash
#
# Runs supabase/schema.sql against a real, throwaway Postgres and checks how
# the owner rank actually behaves.
#
# This exists because a bug got through that no amount of reading could have
# caught: the statement that claims the owner rank was silently a no-op.
# guard_profile_update reverts any role change made by someone who is not an
# admin, and "who" is auth.uid() — which is NULL when you run SQL from the
# Supabase dashboard. The statement reported "UPDATE 1" and changed nothing.
# Only executing it against a real Postgres shows that.
#
#   bash supabase/test/run.sh
#
# Needs the postgres client tools on PATH (initdb, pg_ctl, psql). It creates
# its own cluster on port 55432 and removes it afterwards, so it never touches
# a database you care about and needs no credentials.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCHEMA="$HERE/../schema.sql"
PGDIR="${TMPDIR:-/tmp}/arcade-pgtest-$$"
PORT=55432
CONN="-U postgres -h 127.0.0.1 -p $PORT -w"

command -v initdb >/dev/null || {
  echo "initdb not on PATH. On Windows, add e.g."
  echo "  export PATH=\"/c/Program Files/PostgreSQL/16/bin:\$PATH\""
  exit 2
}

cleanup() {
  pg_ctl -D "$PGDIR" stop -m immediate >/dev/null 2>&1
  rm -rf "$PGDIR"
}
trap cleanup EXIT

echo "· starting a throwaway cluster on port $PORT"
initdb -D "$PGDIR" -U postgres --auth=trust -E UTF8 >/dev/null 2>&1 || { echo "initdb failed"; exit 1; }
pg_ctl -D "$PGDIR" -o "-p $PORT" -l "$PGDIR/log" start >/dev/null 2>&1
for _ in $(seq 1 20); do
  psql $CONN -c "select 1" >/dev/null 2>&1 && break
  sleep 0.5
done
psql $CONN -c "select 1" >/dev/null 2>&1 || { echo "server never came up"; tail -20 "$PGDIR/log"; exit 1; }

fails=0

run_case() {
  local label="$1"; shift
  echo ""
  echo "── $label"
  "$@" || fails=$((fails + 1))
}

fresh_db() {
  dropdb $CONN --if-exists --force archtest >/dev/null 2>&1
  createdb $CONN archtest >/dev/null 2>&1
  psql $CONN -q -v ON_ERROR_STOP=1 -d archtest -c "create extension if not exists citext;" >/dev/null 2>&1
  psql $CONN -q -v ON_ERROR_STOP=1 -d archtest -f "$HERE/00-supabase-stub.sql" >/dev/null 2>&1
}

apply_schema() {
  local out
  out="$(psql $CONN -q -v ON_ERROR_STOP=1 -d archtest -f "$SCHEMA" 2>&1 | grep -iE '^psql.*ERROR|^ERROR|FATAL')"
  if [ -n "$out" ]; then echo "  FAIL  schema errored:"; echo "$out" | head -5; return 1; fi
  echo "  ok    schema applied clean"
}

role_of() {
  psql $CONN -t -A -d archtest -c "select role from public.profiles where username = '$1';"
}

# ---------------------------------------------------------------- fresh
case_fresh() {
  fresh_db
  apply_schema || return 1
  # Capture once: the suite inserts accounts, so a second run would collide
  # on the username unique index and report failures that are not real.
  local out
  out="$(psql $CONN -q -d archtest -f "$HERE/10-owner.test.sql" 2>&1 \
         | grep -E 'ok  |FAIL' | sed 's/^psql:.*NOTICE:  //;s/^NOTICE:  //')"
  echo "$out" | sed 's/^/  /'
  ! echo "$out" | grep -q 'FAIL'
}

# --------------------------------------------------- existing admin account
case_upgrade() {
  fresh_db
  psql $CONN -q -v ON_ERROR_STOP=1 -d archtest -f "$HERE/20-legacy-state.sql" >/dev/null 2>&1
  local before after
  before="$(role_of Stealzers)"
  apply_schema || return 1
  after="$(role_of Stealzers)"
  echo "  ·     Stealzers was '$before', is now '$after'"
  if [ "$before" = "admin" ] && [ "$after" = "owner" ]; then
    echo "  ok    an existing admin account is promoted on re-run"
  else
    echo "  FAIL  expected admin -> owner"; return 1
  fi
}

# ---------------------------------------------------------- idempotency
case_idempotent() {
  local n
  for n in 2 3; do
    apply_schema >/dev/null || { echo "  FAIL  run #$n errored"; return 1; }
  done
  [ "$(role_of Stealzers)" = "owner" ] || { echo "  FAIL  rank drifted on re-run"; return 1; }
  echo "  ok    three consecutive runs, no errors, rank stable"
}

run_case "fresh project"                 case_fresh
run_case "project with an existing admin" case_upgrade
run_case "re-running the file"            case_idempotent

echo ""
echo "========================================================"
if [ "$fails" -gt 0 ]; then
  echo "$fails case(s) FAILED"
  exit 1
fi
echo "All schema cases passed."
