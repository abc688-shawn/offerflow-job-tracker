#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  printf 'Run this installer with sudo.\n' >&2
  exit 1
fi

archive=${1:?release archive is required}
revision=${2:?release revision is required}
server_root=${OFFERFLOW_SERVER_ROOT:-/opt/offerflow}

case "$revision" in
  *[!A-Za-z0-9._-]*)
    printf 'Invalid release revision: %s\n' "$revision" >&2
    exit 1
    ;;
esac

if [ ! -f "$archive" ]; then
  printf 'Release archive does not exist: %s\n' "$archive" >&2
  exit 1
fi

stage_dir=$(mktemp -d "$server_root/.release.XXXXXX")
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
backup_dir="$server_root/backups/code-before-${timestamp}-${revision}"
deployment_started=false
deployment_succeeded=false

cleanup() {
  rm -rf "$stage_dir"
}

rollback() {
  if [ "$deployment_started" = true ] && [ "$deployment_succeeded" != true ]; then
    printf 'Deployment failed; restoring %s\n' "$backup_dir" >&2
    while IFS='|' read -r source_path target_path; do
      case "$source_path" in
        ''|'#'*) continue ;;
      esac
      if [ -f "$backup_dir/$target_path" ]; then
        install -D -m 644 -o root -g root \
          "$backup_dir/$target_path" "$server_root/$target_path"
      elif [ -f "$backup_dir/.missing/$target_path" ]; then
        rm -f "$server_root/$target_path"
      fi
    done < "$stage_dir/server-files.txt"
    chmod 755 "$server_root/bin/offerflow-users-sync" \
      "$server_root/system/renewal-hooks/reload-nginx.sh"
    systemctl daemon-reload
    nginx -t
    systemctl restart nginx
    systemctl restart offerflow
  fi
}

finish() {
  status=$?
  trap - EXIT
  set +e
  rollback
  rollback_status=$?
  cleanup
  if [ "$rollback_status" -ne 0 ]; then
    printf 'Automatic rollback did not complete successfully.\n' >&2
    status=1
  fi
  exit "$status"
}
trap finish EXIT

tar -xzf "$archive" -C "$stage_dir"
manifest="$stage_dir/server-files.txt"
if [ ! -f "$manifest" ]; then
  printf 'Release manifest is missing.\n' >&2
  exit 1
fi

while IFS='|' read -r source_path target_path; do
  case "$source_path" in
    ''|'#'*) continue ;;
  esac
  case "$target_path" in
    app/*|system/*|bin/*) ;;
    *)
      printf 'Unsafe release target: %s\n' "$target_path" >&2
      exit 1
      ;;
  esac
  if [ ! -f "$stage_dir/files/$target_path" ]; then
    printf 'Release file is missing: %s\n' "$target_path" >&2
    exit 1
  fi
done < "$manifest"

PYTHONPYCACHEPREFIX="$stage_dir/pycache" python3 -m py_compile \
  "$stage_dir/files/app/server.py" \
  "$stage_dir/files/app/manage_users.py" \
  "$stage_dir/files/app/backup_offerflow.py"
bash -n \
  "$stage_dir/files/bin/offerflow-users-sync" \
  "$stage_dir/files/system/renewal-hooks/reload-nginx.sh"

install -d -m 750 -o root -g offerflow "$backup_dir"
while IFS='|' read -r source_path target_path; do
  case "$source_path" in
    ''|'#'*) continue ;;
  esac
  if [ -f "$server_root/$target_path" ]; then
    install -D -m 640 -o root -g offerflow \
      "$server_root/$target_path" "$backup_dir/$target_path"
  else
    install -D -m 640 -o root -g offerflow /dev/null \
      "$backup_dir/.missing/$target_path"
  fi
done < "$manifest"

deployment_started=true
systemctl stop offerflow

while IFS='|' read -r source_path target_path; do
  case "$source_path" in
    ''|'#'*) continue ;;
  esac
  mode=644
  case "$target_path" in
    bin/*|system/renewal-hooks/*) mode=755 ;;
  esac
  install -D -m "$mode" -o root -g root \
    "$stage_dir/files/$target_path" "$server_root/$target_path"
done < "$manifest"

systemctl daemon-reload
nginx -t
systemctl restart nginx
systemctl start offerflow

healthy=false
for attempt in $(seq 1 20); do
  if curl --max-time 3 --fail --silent http://127.0.0.1:4173/api/health \
    | grep -q '"ok":true'; then
    healthy=true
    break
  fi
  sleep 1
done

if [ "$healthy" != true ]; then
  printf 'OfferFlow did not pass its health check.\n' >&2
  exit 1
fi

deployment_succeeded=true
printf 'OfferFlow release %s is active.\n' "$revision"
printf 'Previous files: %s\n' "$backup_dir"
