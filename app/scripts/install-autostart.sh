#!/bin/sh
set -eu

app_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
env_file=${SHUFANG_ENV_FILE:-"$app_dir/.env"}
case "$env_file" in
  /*) ;;
  *) env_file="$app_dir/$env_file" ;;
esac
if [ ! -f "$env_file" ]; then
  printf 'Missing environment file: %s\n' "$env_file" >&2
  exit 1
fi
for required in "$app_dir/dist/boot.js" "$app_dir/dist/migrate.js"; do
  if [ ! -f "$required" ]; then
    printf 'Missing %s; run npm run build in the app directory first\n' "$required" >&2
    exit 1
  fi
done
if ! command -v node >/dev/null 2>&1; then
  printf 'Node.js 22 or newer is required and must be on PATH\n' >&2
  exit 1
fi
node_version=$(node -p 'process.versions.node')
node_major=${node_version%%.*}
node_minor=${node_version#*.}
node_minor=${node_minor%%.*}
if [ "$node_major" -lt 22 ] || { [ "$node_major" -eq 22 ] && [ "$node_minor" -lt 13 ]; }; then
  printf 'Node.js 22.13 or newer is required; found %s\n' "$node_version" >&2
  exit 1
fi
if ! command -v systemctl >/dev/null 2>&1; then
  printf 'systemd user services are not available on this Linux system\n' >&2
  exit 1
fi

mode=${1:-}
case "$mode" in
  --enable) enable=true ;;
  --disable) enable=false ;;
  "")
    if [ ! -t 0 ]; then
      printf 'Pass --enable or --disable when running non-interactively\n' >&2
      exit 2
    fi
    printf 'Enable startup when this Linux user logs in? [y/N] '
    IFS= read -r choice || choice=
    case "$choice" in y|Y|yes|YES) enable=true ;; *) enable=false ;; esac
    ;;
  *)
    printf 'Usage: %s [--enable|--disable]\n' "$0" >&2
    exit 2
    ;;
esac

unit_dir=${XDG_CONFIG_HOME:-"$HOME/.config"}/systemd/user
unit_file="$unit_dir/shufang-book-manager.service"
start_script="$app_dir/scripts/start-linux.sh"
path_value=$(command -v node)
path_value=$(dirname -- "$path_value"):$PATH
escape_unit_value() {
  printf '%s' "$1" | sed -e 's/%/%%/g' -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}
mkdir -p "$unit_dir"
{
  printf '[Unit]\nDescription=Shufang Book Manager\nAfter=network.target\n\n[Service]\nType=simple\n'
  printf 'WorkingDirectory="%s"\n' "$(escape_unit_value "$app_dir")"
  printf 'ExecStart=/bin/sh "%s" "%s"\n' \
    "$(escape_unit_value "$start_script")" \
    "$(escape_unit_value "$env_file")"
  printf 'Environment="PATH=%s"\n' "$(escape_unit_value "$path_value")"
  printf 'Restart=on-failure\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n'
} > "$unit_file"
systemctl --user daemon-reload
if [ "$enable" = true ]; then
  systemctl --user enable shufang-book-manager.service
  printf 'Automatic startup is enabled for this Linux user.\n'
else
  systemctl --user disable shufang-book-manager.service >/dev/null 2>&1 || true
  printf 'Startup unit is installed but disabled. Enable it later in App Settings.\n'
fi
