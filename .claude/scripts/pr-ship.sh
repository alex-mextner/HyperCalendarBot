#!/bin/bash
# Repo-specific gh ship delegator. Shared ship runs all review/acceptance/local-CI gates
# and merges first. Hosted Actions is preferred for deployment when healthy; otherwise
# the already-gated merge SHA is deployed through the local fallback.
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel)"
ENV_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/agent-tools/env"
# shellcheck disable=SC1090
[[ -f "$ENV_FILE" && ! -L "$ENV_FILE" ]] && . "$ENV_FILE"
SHARED="${AGENT_TOOLS_ROOT:?AGENT_TOOLS_ROOT unresolved}/ci/ship/ship.sh"
PR="${1:?PR number required}"
case " $* " in *' --dry-run '*) exec "$SHARED" "$@" ;; esac

"$SHARED" "$@"
merge_sha="$(gh pr view "$PR" --json mergeCommit -q '.mergeCommit.oid')"
[[ "$merge_sha" =~ ^[0-9a-f]{40}$ ]] || { echo '[deploy] merged PR has no full merge SHA' >&2; exit 1; }

run_id=""
for _ in $(seq 1 12); do
  run_id="$(gh run list --workflow='CI/CD' --commit "$merge_sha" --limit 1 --json databaseId -q '.[0].databaseId // empty')"
  [[ -n "$run_id" ]] && break
  sleep 5
done

if [[ -n "$run_id" ]]; then
  for _ in $(seq 1 60); do
    IFS=$'\t' read -r status conclusion < <(gh run view "$run_id" --json status,conclusion -q '[.status,.conclusion] | @tsv')
    [[ "$status" == completed ]] && break
    sleep 5
  done
  if [[ "${status:-}" == completed && "${conclusion:-}" == success ]]; then
    echo "[deploy] hosted CI/CD successfully deployed $merge_sha"
    exit 0
  fi
  jobs_json="$(gh run view "$run_id" --json jobs)"
  critical_started=0
  for job_name in test build; do
    started="$(jq -r --arg n "$job_name" '.jobs[] | select(.name==$n) | .startedAt // empty' <<<"$jobs_json")"
    result="$(jq -r --arg n "$job_name" '.jobs[] | select(.name==$n) | .conclusion // empty' <<<"$jobs_json")"
    [[ -n "$started" ]] && critical_started=1
    if [[ -n "$started" && "$result" == failure ]]; then
      echo "[deploy] hosted $job_name job actually ran and failed; refusing fallback" >&2
      exit 1
    fi
  done
  if [[ "${status:-}" != completed && "$critical_started" == 1 ]]; then
    echo "[deploy] hosted test/build is still active; Actions owns deployment"
    exit 0
  fi
  if [[ "${status:-}" != completed ]]; then gh run cancel "$run_id" >/dev/null 2>&1 || true; fi
  echo "[deploy] hosted CI/CD did not complete successfully; using local fallback after successful gh ship gates"
else
  echo "[deploy] hosted CI/CD run did not register; using local fallback after successful gh ship gates"
fi

guard="$(mktemp)"
chmod 600 "$guard"
printf '%s\n' "$merge_sha" > "$guard"
trap 'rm -f "$guard"' EXIT
HYPERCAL_GH_SHIP_GUARD_FILE="$guard" HYPERCAL_SHIP_MERGE_SHA="$merge_sha" \
  "$ROOT/scripts/deploy-local-fallback.sh" "$merge_sha"
