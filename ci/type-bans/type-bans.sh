#!/usr/bin/env bash
# Type-ban gate: fail when the ADDED TypeScript reintroduces a construct this
# repo has decided against.
#
# CLAUDE.md states these bans in prose, and prose is enforced by whoever happens
# to read the diff. Biome already covers two of them (`any` via noExplicitAny,
# `object` via noRestrictedTypes); the rest cannot be expressed as Biome rules,
# so they are checked here instead:
#
#   • as unknown as X   — bypasses every check at once. Banned in src/; test
#                         factories are allowed it (CLAUDE.md's one exception),
#                         so only src/ is scanned for it.
#   • as never          — silences any type error by pretending a value is the
#                         bottom type. Banned everywhere.
#   • Record<string, unknown> — banned everywhere: a known shape wants an
#                         interface, a parse boundary wants unknown, and a real
#                         accumulator wants an explicit index signature.
#   • z.unknown()       — a schema that validates nothing.
#
# Only ADDED lines are scanned, so pre-existing debt does not block anyone; the
# repo has plenty of each and this gate is about not adding more.
#
# Two limits, both deliberate. Comment lines are skipped, because a cast cannot
# live in one and English can. And the scan is line by line, so a construct the
# formatter wrapped across lines is not seen: catching that needs a parser, and
# this is a grep that has to stay readable by whoever it blocks.
#
# Knobs (env):
#   TYPE_BANS_BASE   diff base. Default origin/main -> main -> full-tree scan.
#   TYPE_BANS_HEAD   head ref/SHA to diff against the base. Default HEAD.
#
# Usage: bash ci/type-bans/type-bans.sh
set -euo pipefail

TYPE_BANS_BASE="${TYPE_BANS_BASE:-origin/main}"
TYPE_BANS_HEAD="${TYPE_BANS_HEAD:-HEAD}"
INCLUDE='\.(ts|tsx|mts|cts)$'
EXCLUDE='(^|/)(node_modules|dist|build|coverage)/'

base=""
if git rev-parse --verify --quiet "$TYPE_BANS_BASE" >/dev/null 2>&1; then base="$TYPE_BANS_BASE"
elif git rev-parse --verify --quiet main >/dev/null 2>&1; then base="main"; fi

# (file, lineno, text) for added lines, or every line when there is no base.
emit_lines() {
  if [ -n "$base" ]; then
    git diff --no-color --unified=0 --no-renames "$base...$TYPE_BANS_HEAD" -- . \
      | awk '
        /^\+\+\+ / { f=substr($0,5); sub(/^b\//,"",f); next }
        /^@@ /     { match($0, /\+[0-9]+/); ln=substr($0,RSTART+1,RLENGTH-1)+0; next }
        /^\+/ && f!="" { t=substr($0,2); printf "%s\t%d\t%s\n", f, ln, t; ln++; next }
      '
  else
    git ls-files | while IFS= read -r f; do
      [ -f "$f" ] || continue
      grep -nH '' "$f" 2>/dev/null | sed 's/:/\t/; s/:/\t/'
    done
  fi
}

# `as` must start a word: without this, "w-as unknown as" inside a sentence reads
# as the very cast this bans.
WORD_START='(^|[^[:alnum:]_])'

violations=0

report() {
  violations=$((violations+1))
  echo "::error file=$1,line=$2::[$3] $4"
  echo "  BLOCK [$3] $1:$2  $4" >&2
}

if [ -n "$base" ]; then echo "[type-bans] scanning diff vs ${base} ..." >&2; else echo "[type-bans] scanning full tree ..." >&2; fi

while IFS=$'\t' read -r file ln text; do
  [ -n "${file:-}" ] || continue
  printf '%s' "$file" | grep -qE "$INCLUDE" || continue
  printf '%s' "$file" | grep -qE "$EXCLUDE" && continue

  # A comment cannot hold a cast, and English can say anything in one: "the
  # status was unknown as of the last poll", "regard the empty set as never".
  # Skipping comment lines removes the whole class of false alarms that would
  # otherwise get this gate switched off.
  printf '%s' "$text" | grep -qE '^[[:space:]]*(//|\*|/\*)' && continue

  # Only src/ — a test factory may present a partial mock as the real interface.
  if printf '%s' "$file" | grep -qE '^src/'; then
    printf '%s' "$text" | grep -qE "$WORD_START"'as[[:space:]]+unknown[[:space:]]+as[[:space:]]' \
      && report "$file" "$ln" "double-cast" "$text"
  fi
  # Bounded on both sides. Requiring a closing bracket after it missed both
  # `x as never` at the end of a line and `x as never as Foo`, which fell
  # between this pattern and the one above.
  printf '%s' "$text" | grep -qE "$WORD_START"'as[[:space:]]+never([^[:alnum:]_]|$)' \
    && report "$file" "$ln" "as-never" "$text"
  printf '%s' "$text" | grep -qE 'Record<[[:space:]]*string[[:space:]]*,[[:space:]]*unknown[[:space:]]*>' \
    && report "$file" "$ln" "record-string-unknown" "$text"
  printf '%s' "$text" | grep -qE 'z\.unknown\(\)' \
    && report "$file" "$ln" "z-unknown" "$text"
done < <(emit_lines)

echo "[type-bans] $violations blocking." >&2
[ "$violations" = "0" ] || {
  echo "[type-bans] FAIL — these are banned in CLAUDE.md; fix the types rather than silencing them." >&2
  exit 1
}
echo "[type-bans] PASS."
