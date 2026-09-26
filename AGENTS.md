# HyperCalendarBot agent instructions

Read `CLAUDE.md` and the deployment runbook before changing runtime behavior.

## Delivery and priorities

- Keep a checked-in plan ordered by data-integrity/security incidents, reliability, then performance/features. Reuse existing issues and pull requests before creating duplicates; record every deferred finding with its impact and next action.
- Fix incidents systematically: reproduce with anonymized regression tests, fix the production path, run tests, obtain independent review, fix findings, rerun checks, commit atomically, merge through normal `gh ship`, then verify the exact deployed revision.
- Calendar data repair is not proof that the bot is fixed. Check authoritative tool results, database changes, synchronization and actual delivery separately. Never report a created invitation as delivered or a declined attendance as event deletion.
- Never rerun completed writes merely to repair an explanation. Preserve durable execution evidence across provider changes and retries. Unknown completion is not failure and must not trigger blind replay.
- Validate the exact pull-request head with `bun test`, typecheck and `bun run lint`. Preserve disclosed skips. Use normal local CI fallback when hosted CI is unavailable; do not bypass real failures or manufacture successful checks.
- Install dependencies with the system Bun, which matches the CI pin: `bun install --frozen-lockfile`. Its postinstall (`scripts/install-git-hooks.sh`) installs lefthook only into this repository's own hooks directory, never into a global `core.hooksPath`, and lefthook's own dependency postinstall is not trusted. `trustedDependencies` replaces Bun's default allowlist, so a new dependency that needs its install script must be added there. Do not use `bun x bun@<version>`: Bun before 1.3.14 ignores the shared global store and copies about 0.5 GB into every worktree.
- Never symlink `node_modules` to another checkout (Bun writes through the link; it corrupted the main checkout on 2026-09-09) and never clear the Bun cache (`bun pm cache rm`, `~/.bun/install/cache`).
- Verify version/review requirements and the selected worktree before `gh ship`. Distinguish implemented, reviewed, merged, deployed and live-tested in reports.
- Currency/FX functionality belongs in ExpenseSyncBot. This bot retains a general calculator and date/time arithmetic, not exchange-rate services.

## Branch and worktree cleanup

- Closing or merging a pull request includes cleanup, not just changing its status.
- Before removal, inspect unique commits, staged/unstaged/untracked files, child branches and active processes. Never remove another active task's workspace.
- Preserve useful work in the continuing branch/pull request or a verified recovery bundle and patch, with a manifest linking the replacement. Do not publish credentials or private fixtures.
- Inspect symlinks from surviving worktrees before deleting a target workspace; preserve their original dependency target and verify no broken links remain.
- After preservation is verified, remove the obsolete worktree and unused local/remote branch. Never force-delete unknown dirty work or branches still used by a stacked pull request.

## Human-readable progress

Explain what a change does before citing its issue number. Use concrete dates for past incidents. End reports with verified results, remaining work and open problems; do not equate a test count with completed deployment.

## Interrupted-session recovery

- Before any resumed action, read current main, task/PR state, dirty worktrees, recorded process ownership and the live deployment receipt. The last chat summary is a hint, not execution evidence.
- Save a durable checkpoint before long stages: canonical task ID, exact source SHA/tree, worktree, command, owned PID/start time, log/report paths, last verified result and one next action. Keep credentials/private payloads out.
- An interrupted chat/tool call does not prove the child stopped or the write failed. Reconcile the running process and actual result before retrying. Never queue a second release for a known live owner.
- Use canonical task identifiers (for example GH-325) consistently for review and ship. Validate available CLI flags before invocation; review committed changes via an isolated exact diff, not an empty index.
- On quota/auth failure, record the classification once and use another authorized route. On stalled review, inspect bounded progress and stop only the owned process tree after confirming it is idle. Completed work is preserved; partial review is not approval.
- Noninteractive commands use closed stdin and explicit search roots. Put complex quoting in checked-in or temporary scripts; do not weaken permissions or work around security policy.
- Poll bounded log tails and do useful independent work instead of flooding the conversation with empty one-second polls. No guarantee or invented cause for a platform-level Thinking failed message.
- Ship through the normal shared gates and local CI fallback. If ship removes the PR worktree, continue from the stable canonical repository and exact merged blobs. Preserve useful changes before cleanup.

## Benchmark retention

- Preserve every prior raw measurement and derived score as timestamped, append-only evidence with a source SHA/tree, fixture/prompt/schema version, model settings, scope and checksum. Never overwrite a baseline to make progress look better.
- Separate synthetic payload estimates, small provider probes, controlled live requests and natural traffic distributions. Report sample size, failures, retries, missing usage and delivery boundaries; one sample is not a production percentile target.
- Keep personal conversation/calendar data and credentials out of committed reports. Store private raw records under restricted local logs; checked-in summaries must carry enough methodology to reproduce comparisons safely.
