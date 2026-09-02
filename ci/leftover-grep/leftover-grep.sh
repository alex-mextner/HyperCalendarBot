#!/usr/bin/env bash
# Leftover-marker gate: fail if the CODE introduces debugging/forbidden leftovers.
#
# Catches the classic "oops, left it in" mistakes before they merge:
#   • focused tests        — .only(  / fdescribe / fit(   (silently skip the rest of a suite)
#   • debugger statements  — `debugger;`
#   • stray console logs    — console.log/debug (configurable; warn vs block)
#   • untracked TODOs       — TODO/FIXME WITHOUT an issue reference (TODO(ABC-123) is ok)
#   • merge conflict markers — <<<<<<< / ======= / >>>>>>>
#
# By default it scans only the lines ADDED in the PR diff (so it doesn't punish you for
# pre-existing debt), falling back to a full-tree scan when no base ref is available.
#
# Knobs (env):
#   LEFTOVER_BASE        diff base. Default origin/main -> main -> full-tree scan.
#   LEFTOVER_INCLUDE     ERE of file paths to scan. Default: source-ish extensions.
#   LEFTOVER_EXCLUDE     ERE of paths to skip. Default: vendored/build/lock dirs.
#   TICKET_REGEX         what makes a TODO "tracked". Default: TODO/FIXME followed by
#                        (ABC-123) or (#123) or a URL. Customize for your tracker.
#   ALLOW_CONSOLE        "1" = console.log is a WARNING, not a failure (default: block).
#   CONSOLE_EXCLUDE      ERE of paths where console output IS the interface (developer
#                        CLIs, generators), so only the console rule is skipped there —
#                        focused tests, debuggers and untracked TODOs still block.
#                        Default: empty (the console rule applies everywhere).
#   LEFTOVER_FULLTREE    "1" = always scan the whole tree, ignore the diff.
#
# Known limit: in diff mode a symlink is scanned as its own added line (the target
# path), not as the file it points at, so a link from an unexcluded path into an
# excluded one is not resolved. The full-tree scan follows links and is stricter.
#   LEFTOVER_HEAD        head ref/SHA to diff against the base. Default HEAD. Under a
#                        tamper-resistant pull_request_target setup this is the PR head SHA,
#                        fetched as DATA — `git diff` + grep only READ those lines, they
#                        never execute PR code — so the trusted base script still gates.
#
# Usage: sh ci/leftover-grep/leftover-grep.sh
set -euo pipefail

LEFTOVER_BASE="${LEFTOVER_BASE:-origin/main}"
LEFTOVER_HEAD="${LEFTOVER_HEAD:-HEAD}"
LEFTOVER_INCLUDE="${LEFTOVER_INCLUDE:-\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|java|kt|c|h|cpp|hpp|cs|php|swift|sh)$}"
LEFTOVER_EXCLUDE="${LEFTOVER_EXCLUDE:-(^|/)(node_modules|dist|build|out|vendor|\.git|coverage|__snapshots__)/|\.min\.(js|css)$|lock$}"
TICKET_REGEX="${TICKET_REGEX:-[A-Z]+-[0-9]+|#[0-9]+|https?://}"
ALLOW_CONSOLE="${ALLOW_CONSOLE:-0}"
CONSOLE_EXCLUDE="${CONSOLE_EXCLUDE:-}"
LEFTOVER_FULLTREE="${LEFTOVER_FULLTREE:-0}"

# Resolve a base ref or empty (-> full-tree scan).
base=""
if [ "$LEFTOVER_FULLTREE" != "1" ]; then
  if git rev-parse --verify --quiet "$LEFTOVER_BASE" >/dev/null 2>&1; then base="$LEFTOVER_BASE"
  elif git rev-parse --verify --quiet main >/dev/null 2>&1; then base="main"; fi
fi

# Collect (file, lineno, line) tuples for ADDED lines (diff) or all lines (full tree).
# Output format: <file>\t<lineno>\t<text>
emit_lines() {
  if [ -n "$base" ]; then
    # Parse `git diff` unified output, tracking the new-file line number, emitting only '+'
    # lines (added). Robust enough for a gate without extra deps.
    # --no-renames: a rename carries no added lines, so a file MOVED out of a
    # per-rule exclusion (a console-printing CLI moved from scripts/ into src/)
    # would never be scanned at its new path. Split into a delete and an add, the
    # destination is read in full and every rule applies to it there.
    git diff --no-color --unified=0 --no-renames "$base...$LEFTOVER_HEAD" -- . \
      | awk '
        # substr, not $2: a path containing a space would be truncated at the
        # space, and the truncated name matches no include pattern — the file
        # would then skip EVERY rule, silently.
        /^\+\+\+ /      { f=substr($0,5); sub(/^b\//,"",f); next }
        /^@@ /          { match($0, /\+[0-9]+/); ln=substr($0,RSTART+1,RLENGTH-1)+0; next }
        /^\+/ && f!=""  { t=substr($0,2); printf "%s\t%d\t%s\n", f, ln, t; ln++; next }
      '
  else
    # Full-tree scan of tracked files.
    git ls-files | while IFS= read -r f; do
      [ -f "$f" ] || continue
      grep -nH '' "$f" 2>/dev/null | sed 's/:/\t/; s/:/\t/' || true
    done
  fi
}

violations=0
warnings=0
report() { # <severity> <file> <lineno> <rule> <text>
  if [ "$1" = "WARN" ]; then warnings=$((warnings+1)); echo "  warn  [$4] $2:$3  $5" >&2
  else violations=$((violations+1)); echo "::error file=$2,line=$3::[$4] $5"; echo "  BLOCK [$4] $2:$3  $5" >&2; fi
}

if [ -n "$base" ]; then echo "[leftover] scanning diff vs ${base} ..." >&2; else echo "[leftover] scanning full tree ..." >&2; fi

while IFS=$'\t' read -r file ln text; do
  [ -n "${file:-}" ] || continue
  printf '%s' "$file" | grep -qE "$LEFTOVER_INCLUDE" || continue
  printf '%s' "$file" | grep -qE "$LEFTOVER_EXCLUDE" && continue

  # focused tests
  printf '%s' "$text" | grep -qE '\.only\(|(^|[^a-zA-Z])f(describe|it|test)\(' && report BLOCK "$file" "$ln" "focused-test" "$text"
  # debugger
  printf '%s' "$text" | grep -qE '(^|[^a-zA-Z])debugger;?\s*$' && report BLOCK "$file" "$ln" "debugger" "$text"
  # merge conflict markers
  printf '%s' "$text" | grep -qE '^(<{7}|={7}|>{7})( |$)' && report BLOCK "$file" "$ln" "merge-marker" "$text"
  # console.log/debug
  if printf '%s' "$text" | grep -qE 'console\.(log|debug)\('; then
    # Silent, not a WARN: on an excluded path these lines ARE the product, so
    # every run would print the same dozen warnings and teach the reader to skim
    # past all of them. Paths here are repo-root-relative in both modes (the diff
    # branch strips the b/ prefix, the full-tree branch uses `git ls-files`), so
    # an anchored pattern like ^scripts/ matches in both.
    if [ -n "$CONSOLE_EXCLUDE" ] && printf '%s' "$file" | grep -qE "$CONSOLE_EXCLUDE"; then
      :
    elif [ "$ALLOW_CONSOLE" = "1" ]; then report WARN "$file" "$ln" "console" "$text"
    else report BLOCK "$file" "$ln" "console" "$text"; fi
  fi
  # TODO/FIXME without a tracker reference
  if printf '%s' "$text" | grep -qE '(TODO|FIXME)'; then
    printf '%s' "$text" | grep -qE "($TICKET_REGEX)" || report BLOCK "$file" "$ln" "untracked-todo" "$text"
  fi
done < <(emit_lines)

echo "[leftover] $violations blocking, $warnings warning(s)." >&2
[ "$violations" = "0" ] || { echo "[leftover] FAIL — remove the leftovers above (or reference a ticket on the TODO)." >&2; exit 1; }
echo "[leftover] PASS."
