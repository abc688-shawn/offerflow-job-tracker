#!/bin/sh
set -eu

mkdir -p /data
chown offerflow:offerflow /data
chown offerflow:offerflow /data/offerflow.db /data/offerflow.db-shm /data/offerflow.db-wal 2>/dev/null || true

exec setpriv --reuid=offerflow --regid=offerflow --init-groups --no-new-privs "$@"
