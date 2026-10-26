#!/usr/bin/env bash
# Shared ship owns review, local CI and merge; deployment follows that merge.
set -euo pipefail
common="$(git rev-parse --path-format=absolute --git-common-dir)"
[[ "$common" == */.git ]] || { echo 'Canonical repository location required' >&2; exit 2; }
canonical="${common%/.git}"
root="${AGENT_TOOLS_ROOT:-}"
env_file="${XDG_CONFIG_HOME:-$HOME/.config}/agent-tools/env"
if [[ -f "$env_file" && ! -L "$env_file" ]]; then . "$env_file"; fi
root="${root:-${AGENT_TOOLS_ROOT:-}}"
[[ -n "$root" && -x "$root/ci/ship/ship.sh" ]] || { echo 'Shared gh ship unavailable' >&2; exit 127; }
shared="$root/ci/ship/ship.sh"
pr="${1:-}"
[[ "$pr" =~ ^[0-9]+$ ]] || exec "$shared" "$@"
for argument in "$@"; do
  [[ "$argument" != --dry-run ]] || exec "$shared" "$@"
done
name="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
previous=""
for argument in "$@"; do
  if [[ "$previous" == --repo && "$argument" != "$name" ]]; then
    echo 'Repository override differs from local deployment repository' >&2; exit 2
  fi
  if [[ "$argument" == --repo=* && "${argument#--repo=}" != "$name" ]]; then
    echo 'Repository override differs from local deployment repository' >&2; exit 2
  fi
  previous="$argument"
done
# Stage QA must be green for the exact PR head before the shared ship may merge (#840). The gate that
# runs is origin/main's copy, never the PR checkout's: a PR could otherwise edit its own gate. Until the
# script exists on main (bootstrap) there is nothing to run, and the notice says so.
git -C "$canonical" fetch -q origin main 2>/dev/null || true
gate="$(mktemp)"
gate_rc=0
if git -C "$canonical" show origin/main:scripts/stage-qa-gate.py >"$gate" 2>/dev/null; then
  (cd "$(git rev-parse --show-toplevel)" && python3 -B "$gate" --repo "$name" --pr "$pr") || gate_rc=$?
else
  echo 'stage-qa gate: scripts/stage-qa-gate.py is not on origin/main yet (bootstrap); Stage QA is NOT enforced for this ship.' >&2
fi
rm -f "$gate"
(( gate_rc == 0 )) || exit "$gate_rc"
after_merge() {
  "$shared" "$@"
  cd "$canonical"
  sha="$(gh pr view "$pr" --repo "$name" --json mergeCommit --jq '.mergeCommit.oid // empty')"
  [[ "$sha" =~ ^[a-f0-9]{40}$ ]] || { echo 'Merged PR has no full SHA' >&2; return 1; }
  # Fetch the exact merged script even if shared ship removed the starting worktree.
  git fetch origin main
  temp="$(mktemp -d)"
  trap 'rm -rf "$temp"' EXIT
  git show "$sha:scripts/post-ship-deploy.py" > "$temp/post-ship-deploy.py"
  python3 -B "$temp/post-ship-deploy.py" --repo "$canonical" --pr "$pr" --sha "$sha"
}
after_merge "$@"
