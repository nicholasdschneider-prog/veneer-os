#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 || ! -f "$1" ]]; then
  echo "Usage: $0 /path/to/veneer-pro-backup.tar.gz" >&2
  exit 2
fi

archive="$(realpath "$1")"
user_name="${VP_USER:-veneer}"
user_home="$(getent passwd "$user_name" | cut -d: -f6)"
data_dir="${DATA_DIR:-$user_home/.local/share/veneer-pro}"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
recovery_dir="${data_dir}.before-restore-$stamp"
runtime_dir="/run/user/$(id -u "$user_name")"
work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

tar -C "$work_dir" -xzf "$archive"
[[ -d "$work_dir/data" ]] || { echo "Backup does not contain a data directory." >&2; exit 1; }

sudo -u "$user_name" XDG_RUNTIME_DIR="$runtime_dir" systemctl --user stop \
  veneer-pro.service veneer-pro-runner.service veneer-pro-app-runner.service
if [[ -e "$data_dir" ]]; then
  mv "$data_dir" "$recovery_dir"
fi
install -d -o "$user_name" -g "$user_name" -m 700 "$data_dir"
rsync -a "$work_dir/data/" "$data_dir/"
chown -R "$user_name:$user_name" "$data_dir"
sudo -u "$user_name" XDG_RUNTIME_DIR="$runtime_dir" systemctl --user start \
  veneer-pro-runner.service veneer-pro-app-runner.service veneer-pro.service
echo "Restored $archive. Previous data is recoverable at $recovery_dir"
