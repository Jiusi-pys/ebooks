#!/bin/sh
set -eu
app_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
env_file=${1:-"$app_dir/.env"}
case "$env_file" in
  /*) ;;
  *) env_file="$app_dir/$env_file" ;;
esac
if [ ! -f "$env_file" ]; then
  printf 'Missing environment file: %s\n' "$env_file" >&2
  exit 1
fi
cd "$app_dir"
NODE_ENV=production node --env-file="$env_file" dist/migrate.js
exec env NODE_ENV=production node --env-file="$env_file" dist/boot.js
