#!/usr/bin/env bash
# Each invocation owns immutable report paths; failed/targeted runs cannot reuse a prior full report.
set -euo pipefail
cd "$(dirname "$0")/.."
BUN_BIN="${BUN_BIN:-bun}"
mkdir -p coverage
REPORT_DIR="$(mktemp -d "$PWD/coverage/full-XXXXXXXX")"
echo "Full-suite reports: $REPORT_DIR"
mkdir -p "$REPORT_DIR/tmp"
export TMPDIR="$REPORT_DIR/tmp"
UNIT_STATUS=0
BROWSER_STATUS=0
COVERAGE_STATUS=0
"$BUN_BIN" --no-env-file test ./test/ --path-ignore-patterns='**/playwright-pool.test.ts' \
  --coverage --coverage-reporter=text --coverage-reporter=lcov --coverage-dir="$REPORT_DIR/unit" || UNIT_STATUS=$?
# A separate process prevents mock.module('playwright') from replacing Chromium.
"$BUN_BIN" --no-env-file test ./test/worker/playwright-pool.test.ts \
  --coverage --coverage-reporter=text --coverage-reporter=lcov --coverage-dir="$REPORT_DIR/browser" || BROWSER_STATUS=$?
printf '{"unitExitCode":%s,"browserExitCode":%s}\n' "$UNIT_STATUS" "$BROWSER_STATUS" > "$REPORT_DIR/tests.json"
if [[ ! -s "$REPORT_DIR/unit/lcov.info" ]]; then echo 'Missing fresh full-suite report' >&2; exit 1; fi
if [[ ! -s "$REPORT_DIR/browser/lcov.info" ]]; then echo 'Missing fresh browser report' >&2; exit 1; fi
cat "$REPORT_DIR/unit/lcov.info" "$REPORT_DIR/browser/lcov.info" > "$REPORT_DIR/lcov.info"
"$BUN_BIN" ci/coverage-check.ts "$REPORT_DIR/lcov.info" "$REPORT_DIR/summary.json" || COVERAGE_STATUS=$?
[[ "$UNIT_STATUS" == 0 && "$BROWSER_STATUS" == 0 && "$COVERAGE_STATUS" == 0 ]]
