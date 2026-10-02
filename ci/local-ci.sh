#!/usr/bin/env bash
# Use an already installed pinned Bun; local CI must not download tools or access credentials.
set -euo pipefail
cd "$(dirname "$0")/.."
export BUN_BIN="${BUN_BIN:-bun}"
if [[ "$("$BUN_BIN" --version)" != '1.3.11' ]]; then
  echo 'Local CI requires Bun 1.3.11. Set BUN_BIN to its installed executable.' >&2
  exit 1
fi
"$BUN_BIN" node_modules/typescript/bin/tsc --noEmit
"$BUN_BIN" run lint
bash ci/test-coverage.sh
