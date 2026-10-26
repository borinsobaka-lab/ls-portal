#!/usr/bin/env bash
# Pull Request разработчика «Аналитики сети» (из форка) меняет только файлы
# раздела — CLAUDE.md, «Разработчик аналитики». Вход — строки
# `git diff --name-status` (статус и пути через табуляцию), выход 1 — есть
# файлы вне раздела. Это фильтр, а не граница безопасности: код и миграции
# раздела всё равно читают перед merge.
#
#   git diff --name-status origin/main...HEAD | bash .github/scripts/analytics-paths.sh
set -uo pipefail

allowed() {
  case "$1" in
    apps/admin/src/components/analytics/* | \
    apps/admin/src/lib/analytics/* | \
    apps/admin/src/routes/_authenticated/analytics/* | \
    apps/admin/src/hooks/use-analytics-filters.ts | \
    apps/admin/src/routeTree.gen.ts | \
    db/analytics.test.ts | \
    ANALYTICS.md)
      return 0 ;;
  esac
  return 1
}

# Новая миграция раздела: только добавить, `analytics` в имени. Выкаченные
# миграции не правятся (исправление — новый файл), чужие — тем более.
new_migration() {
  [[ "$1" =~ ^db/migrations/20[0-9]{2}-[0-9]{2}-[0-9]{2}_[a-z0-9_]*analytics[a-z0-9_]*\.sql$ ]]
}

bad=() migrations=() route_tree=0 total=0
while IFS=$'\t' read -r status path1 path2; do
  [[ -z "${status:-}" ]] && continue
  total=$((total + 1))
  if [[ "$status" == A* ]] && new_migration "$path1"; then
    migrations+=("$path1")
    continue
  fi
  for p in "$path1" ${path2:+"$path2"}; do
    if allowed "$p"; then
      [[ "$p" == apps/admin/src/routeTree.gen.ts ]] && route_tree=1
    else
      bad+=("$status $p")
    fi
  done
done

echo "Файлов в Pull Request: $total"
if ((${#migrations[@]})); then
  echo "Новые миграции — прочитать SQL целиком перед merge (миграция может менять любую таблицу):"
  printf '  %s\n' "${migrations[@]}"
fi
((route_tree)) && echo "Изменён routeTree.gen.ts — проверить, что там только маршруты /analytics."
if ((${#bad[@]})); then
  echo "Вне раздела «Аналитика» (такие правки — через владельца портала):"
  printf '  %s\n' "${bad[@]}"
  exit 1
fi
echo "Все файлы — в разделе «Аналитика»."
