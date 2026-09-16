#!/usr/bin/env bash
set -euo pipefail

data_dir="${DATA_DIR:-$HOME/.local/share/veneer-pro}"
backup_dir="${VP_BACKUP_DIR:-$HOME/.local/share/veneer-pro-backups}"
keep="${VP_BACKUP_KEEP:-7}"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
work_dir="$(mktemp -d)"
archive="$backup_dir/veneer-pro-$stamp.tar.gz"
trap 'rm -rf "$work_dir"' EXIT

mkdir -p "$backup_dir" "$work_dir/data"
if [[ -f "$data_dir/veneer-pro.db" ]]; then
  sqlite3 "$data_dir/veneer-pro.db" ".timeout 5000" ".backup '$work_dir/data/veneer-pro.db'"
fi
rsync -a --exclude 'veneer-pro.db' --exclude 'veneer-pro.db-wal' --exclude 'veneer-pro.db-shm' \
  --exclude 'doppler.json' --exclude 'hub-keyring.json' --exclude '.hub-keyring.*.tmp' \
  "$data_dir/" "$work_dir/data/"
tar -C "$work_dir" -czf "$archive" data
chmod 600 "$archive"

mapfile -t old_backups < <(find "$backup_dir" -maxdepth 1 -type f -name 'veneer-pro-*.tar.gz' -printf '%T@ %p\n' | sort -rn | tail -n "+$((keep + 1))" | cut -d' ' -f2-)
if ((${#old_backups[@]})); then
  rm -f -- "${old_backups[@]}"
fi
printf '%s\n' "$archive"
