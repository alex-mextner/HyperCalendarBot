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
