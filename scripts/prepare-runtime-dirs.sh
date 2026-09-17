#!/usr/bin/env bash
# Prepare bind-mounted runtime directories for the non-root bot container.
# Run as root on the deployment host before `docker compose up`.
set -euo pipefail

ROOT="${1:-.}"
BOT_UID="${BOT_UID:-999}"
BOT_GID="${BOT_GID:-999}"

mkdir -p "$ROOT/data" "$ROOT/logs"
chown -R "$BOT_UID:$BOT_GID" "$ROOT/data" "$ROOT/logs"

owner_of() {
  stat -c '%u:%g' "$1" 2>/dev/null || stat -f '%u:%g' "$1"
}

for dir in data logs; do
  actual="$(owner_of "$ROOT/$dir")"
  expected="$BOT_UID:$BOT_GID"
  if [[ "$actual" != "$expected" ]]; then
    echo "runtime directory ownership mismatch: $ROOT/$dir is $actual, expected $expected" >&2
    exit 1
  fi
done

echo "runtime directories ready: data=$BOT_UID:$BOT_GID logs=$BOT_UID:$BOT_GID"
