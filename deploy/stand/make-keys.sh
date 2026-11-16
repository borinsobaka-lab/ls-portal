#!/usr/bin/env bash
# Ключи стенда «Аналитики» на случай, если Coolify не создал их сам
# (DEPLOY.md, шаг 18): anon- и service_role-ключи — JWT HS256 с секретом JWT
# стенда, срок — 10 лет (как у шаблона Supabase). Только bash и openssl.
#
#   bash make-keys.sh <секрет JWT>      — ключи для этого секрета
#   bash make-keys.sh                   — новый секрет и ключи к нему
#
# Печатает три строки ИМЯ=значение для переменных сервиса стенда:
# SERVICE_PASSWORD_JWT, SERVICE_SUPABASEANON_KEY, SERVICE_SUPABASESERVICE_KEY.
set -euo pipefail

secret="${1:-$(openssl rand -hex 32)}"

b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

jwt() {
  local role="$1" now exp header payload sig
  now=$(date +%s)
  exp=$((now + 10 * 365 * 24 * 3600))
  header=$(printf '{"alg":"HS256","typ":"JWT"}' | b64url)
  payload=$(printf '{"role":"%s","iss":"supabase","iat":%d,"exp":%d}' "$role" "$now" "$exp" | b64url)
  sig=$(printf '%s.%s' "$header" "$payload" | openssl dgst -sha256 -hmac "$secret" -binary | b64url)
  printf '%s.%s.%s' "$header" "$payload" "$sig"
}

echo "SERVICE_PASSWORD_JWT=$secret"
echo "SERVICE_SUPABASEANON_KEY=$(jwt anon)"
echo "SERVICE_SUPABASESERVICE_KEY=$(jwt service_role)"
