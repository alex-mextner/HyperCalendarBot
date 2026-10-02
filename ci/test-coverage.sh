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
TEST_STATUS=0
COVERAGE_STATUS=0
# The real-browser pool suite already runs Chromium in its own child process
# (test/worker/playwright-pool.test.ts), so one full-suite process is enough.
"$BUN_BIN" --no-env-file test ./test/ \
  --coverage --coverage-reporter=text --coverage-reporter=lcov --coverage-dir="$REPORT_DIR" || TEST_STATUS=$?
printf '{"testExitCode":%s}\n' "$TEST_STATUS" > "$REPORT_DIR/tests.json"
if [[ ! -s "$REPORT_DIR/lcov.info" ]]; then echo 'Missing fresh full-suite report' >&2; exit 1; fi
"$BUN_BIN" ci/coverage-check.ts "$REPORT_DIR/lcov.info" "$REPORT_DIR/summary.json" || COVERAGE_STATUS=$?
[[ "$TEST_STATUS" == 0 && "$COVERAGE_STATUS" == 0 ]]
