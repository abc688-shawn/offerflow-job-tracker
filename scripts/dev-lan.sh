#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
listen_host=${OFFERFLOW_LOCAL_HOST:-0.0.0.0}
listen_port=${OFFERFLOW_LOCAL_PORT:-4173}
database_path=${OFFERFLOW_LOCAL_DB:-"$repo_dir/data/offerflow.db"}

detect_lan_ip() {
  local address=""
  local interface_name=""

  if command -v ipconfig >/dev/null 2>&1; then
    for interface_name in en0 en1; do
      address=$(ipconfig getifaddr "$interface_name" 2>/dev/null || true)
      if [ -n "$address" ]; then
        printf '%s\n' "$address"
        return
      fi
    done
  fi

  if command -v hostname >/dev/null 2>&1; then
    address=$(hostname -I 2>/dev/null | awk '{print $1}' || true)
    if [ -n "$address" ]; then
      printf '%s\n' "$address"
    fi
  fi
}

cd "$repo_dir"
mkdir -p "$(dirname "$database_path")"

if [ "${OFFERFLOW_SKIP_BUILD:-false}" != "true" ]; then
  npm run build
fi

lan_ip=$(detect_lan_ip)
printf '\nOfferFlow local development server\n'
printf '  This device: http://127.0.0.1:%s\n' "$listen_port"
if [ -n "$lan_ip" ]; then
  printf '  Local network: http://%s:%s\n' "$lan_ip" "$listen_port"
else
  printf '  Local network: use this computer\047s LAN IP with port %s\n' "$listen_port"
fi
printf '  Database: %s\n\n' "$database_path"
printf 'Keep this terminal open. Press Ctrl+C to stop.\n\n'

OFFERFLOW_SECURE_COOKIES=false \
  python3 server.py --host "$listen_host" --port "$listen_port" --db "$database_path"
