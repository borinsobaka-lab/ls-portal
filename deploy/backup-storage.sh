#!/usr/bin/env bash
# Ежедневный архив файлов Supabase Storage (картинки и видео статей и
# курсов — бакет kb-media и остальные) в S3 Selectel. Бэкап Postgres в
# Coolify файлов не содержит: они лежат на диске сервера.
#
# Установка (DEPLOY.md, шаг 10): apt install rclone; remote «selectel» —
# в /root/.config/rclone/rclone.conf; cron:
#   15 3 * * * /opt/ls-portal/backup-storage.sh /data/coolify/services/<uuid>/volumes/storage >> /var/log/ls-storage-backup.log 2>&1
#
# Аргумент — папка storage сервиса Supabase. Переменные (необязательно):
# REMOTE (selectel:ls-portal-backups/storage), KEEP_DAYS (30).
set -euo pipefail

SRC="${1:?укажите папку storage Supabase}"
REMOTE="${REMOTE:-selectel:ls-portal-backups/storage}"
KEEP_DAYS="${KEEP_DAYS:-30}"
DAY="$(date +%F)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

[ -d "$SRC" ] || { echo "$(date -Is) нет папки $SRC" >&2; exit 1; }

tar -C "$SRC" -czf "$TMP/storage-$DAY.tar.gz" .
rclone copyto "$TMP/storage-$DAY.tar.gz" "$REMOTE/storage-$DAY.tar.gz"
rclone delete --min-age "${KEEP_DAYS}d" "$REMOTE"
echo "$(date -Is) готово: storage-$DAY.tar.gz, $(du -h "$TMP/storage-$DAY.tar.gz" | cut -f1)"
