#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
manifest="$repo_dir/scripts/server-files.txt"
installer="$repo_dir/scripts/install-server-release.sh"
server=${OFFERFLOW_DEPLOY_SERVER:-admin@139.196.218.231}
identity_file=${OFFERFLOW_DEPLOY_KEY:-"${HOME}/.ssh/offerflow_deploy_ed25519"}
server_root=${OFFERFLOW_SERVER_ROOT:-/opt/offerflow}
release_dir=$(mktemp -d "${TMPDIR:-/tmp}/offerflow-release.XXXXXX")
remote_archive="/tmp/offerflow-release-$$.tar.gz"
remote_installer="/tmp/offerflow-install-release-$$.sh"

cleanup() {
  rm -rf "$release_dir"
  if [ -r "$identity_file" ]; then
    ssh -i "$identity_file" -o BatchMode=yes "$server" \
      "rm -f '$remote_archive' '$remote_installer'" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

if [ ! -r "$identity_file" ]; then
  printf 'SSH identity file is not readable: %s\n' "$identity_file" >&2
  exit 1
fi

cd "$repo_dir"
npm run build
node --check app.js
node --check auth-react.js
PYTHONPYCACHEPREFIX="$release_dir/pycache" python3 -m py_compile \
  server.py manage_users.py deploy/backup_offerflow.py
bash -n deploy/offerflow-users-sync \
  deploy/renewal-hooks/reload-nginx.sh scripts/*.sh

if [ "${OFFERFLOW_SKIP_TESTS:-false}" != "true" ]; then
  python3 -m unittest discover -s tests
fi

mkdir -p "$release_dir/files"
while IFS='|' read -r local_path server_path; do
  case "$local_path" in
    ''|'#'*) continue ;;
  esac
  case "$server_path" in
    app/*|system/*|bin/*) ;;
    *)
      printf 'Unsafe server path in manifest: %s\n' "$server_path" >&2
      exit 1
      ;;
  esac
  if [ ! -f "$local_path" ]; then
    printf 'Deployment file is missing: %s\n' "$local_path" >&2
    exit 1
  fi
  mkdir -p "$release_dir/files/$(dirname "$server_path")"
  cp "$local_path" "$release_dir/files/$server_path"
done < "$manifest"
cp "$manifest" "$release_dir/server-files.txt"

if git diff --quiet && git diff --cached --quiet; then
  revision=$(git rev-parse --short=12 HEAD)
else
  revision="working-tree-$(date -u +%Y%m%dT%H%M%SZ)"
fi

archive="$release_dir/release.tar.gz"
tar -czf "$archive" -C "$release_dir" files server-files.txt

printf 'Deploying %s to %s:%s\n' "$revision" "$server" "$server_root"
scp -i "$identity_file" -o BatchMode=yes -o ConnectTimeout=10 \
  "$archive" "$server:$remote_archive"
scp -i "$identity_file" -o BatchMode=yes -o ConnectTimeout=10 \
  "$installer" "$server:$remote_installer"
ssh -i "$identity_file" -o BatchMode=yes "$server" \
  "chmod 755 '$remote_installer' && \
   sudo OFFERFLOW_SERVER_ROOT='$server_root' '$remote_installer' '$remote_archive' '$revision'"

OFFERFLOW_DEPLOY_SERVER="$server" \
OFFERFLOW_DEPLOY_KEY="$identity_file" \
OFFERFLOW_SERVER_ROOT="$server_root" \
  "$repo_dir/scripts/check-server-sync.sh"

printf 'Public service: https://139.196.218.231\n'
