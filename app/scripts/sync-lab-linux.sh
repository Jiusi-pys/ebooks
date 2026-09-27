#!/bin/sh
set -eu
lab=/opt/shufang-sync-lab
mkdir -p "$lab/release"
tar -xzf "$lab/release.tar.gz" -C "$lab/release"
chmod 600 "$lab/linux.env"
docker rm -f shufang-sync-lab 2>/dev/null || true
docker run -d --name shufang-sync-lab --network host \
  --env-file "$lab/linux.env" \
  --mount "type=bind,src=$lab,dst=/lab" \
  --mount "type=bind,src=$lab/release/dist,dst=/app/dist,readonly" \
  --mount "type=bind,src=$lab/release/db/migrations,dst=/app/db/migrations,readonly" \
  shufang-sync-lab:20260927
