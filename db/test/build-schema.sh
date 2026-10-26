#!/usr/bin/env bash
# Схема для тестов базы (db/packages.test.ts) на локальном Postgres 16:
# заглушки Supabase (auth, storage, роли) → старые db/*.sql (выполнялись
# вручную; порядок между ними не записан, поэтому три прохода с пропуском
# ошибок) → все db/migrations/*.sql по порядку имён, каждая в транзакции, с
# остановкой на первой ошибке — как мигратор.
#
#   bash db/test/build-schema.sh postgres://postgres@localhost:5432/base40_test
#   TEST_SCHEMA_DATABASE_URL=postgres://postgres@localhost:5432/base40_test bun test db
#
# База пересоздаётся целиком — указывайте ту, которую не жалко.
set -euo pipefail

URL="${1:?укажите адрес базы: postgres://user@host:port/db}"
DB_NAME="${URL##*/}"
ADMIN_URL="${URL%/*}/postgres"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

psql "$ADMIN_URL" -q -X -c "drop database if exists \"$DB_NAME\"" -c "create database \"$DB_NAME\"" >/dev/null
psql "$URL" -q -X -v ON_ERROR_STOP=1 -f "$HERE/stubs.sql" >/dev/null

for pass in 1 2 3; do
  for f in "$ROOT"/*.sql; do
    psql "$URL" -q -X -v ON_ERROR_STOP=0 -f "$f" >/dev/null 2>&1 || true
  done
done
psql "$URL" -q -X -v ON_ERROR_STOP=1 -f "$ROOT/bootstrap/fixups.sql" >/dev/null

for f in "$ROOT"/migrations/*.sql; do
  if ! out=$(psql "$URL" -q -X -v ON_ERROR_STOP=1 -1 -f "$f" 2>&1 >/dev/null); then
    echo "Миграция не выполнилась: $(basename "$f")" >&2
    echo "$out" | grep -v NOTICE >&2
    exit 1
  fi
done
echo "Схема собрана: $URL"
