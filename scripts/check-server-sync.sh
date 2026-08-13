#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
manifest="$repo_dir/scripts/server-files.txt"
server=${OFFERFLOW_DEPLOY_SERVER:-admin@139.196.218.231}
identity_file=${OFFERFLOW_DEPLOY_KEY:-"${HOME}/.ssh/offerflow_deploy_ed25519"}
server_root=${OFFERFLOW_SERVER_ROOT:-/opt/offerflow}
local_hashes=$(mktemp "${TMPDIR:-/tmp}/offerflow-local-hashes.XXXXXX")
remote_hashes=$(mktemp "${TMPDIR:-/tmp}/offerflow-remote-hashes.XXXXXX")
remote_paths=$(mktemp "${TMPDIR:-/tmp}/offerflow-remote-paths.XXXXXX")

cleanup() {
  rm -f "$local_hashes" "$remote_hashes" "$remote_paths"
}
trap cleanup EXIT

if [ ! -r "$identity_file" ]; then
  printf 'SSH identity file is not readable: %s\n' "$identity_file" >&2
  exit 1
fi

cd "$repo_dir"
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
    printf 'Local deployment file is missing: %s\n' "$local_path" >&2
    exit 1
  fi
  hash=$(shasum -a 256 "$local_path" | awk '{print $1}')
  printf '%s  %s\n' "$hash" "$server_path" >> "$local_hashes"
  printf '%s/%s\n' "$server_root" "$server_path" >> "$remote_paths"
done < "$manifest"

ssh -i "$identity_file" -o BatchMode=yes -o ConnectTimeout=10 "$server" \
  "xargs sha256sum" < "$remote_paths" \
  | awk -v root="$server_root/" '{sub(root, "", $2); print $1 "  " $2}' \
  > "$remote_hashes"

if diff -u "$local_hashes" "$remote_hashes"; then
  printf 'OfferFlow application and deployment files are in sync with %s.\n' "$server"
else
  printf '\nOfferFlow files differ. Run npm run deploy:server after reviewing local changes.\n' >&2
  exit 1
fi
