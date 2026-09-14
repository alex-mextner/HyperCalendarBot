# HyperCalendarBot agent instructions

Read `CLAUDE.md` and the deployment runbook before changing runtime behavior.

## Delivery and priorities

- Keep a checked-in plan ordered by data-integrity/security incidents, reliability, then performance/features. Reuse existing issues and pull requests before creating duplicates; record every deferred finding with its impact and next action.
- Fix incidents systematically: reproduce with anonymized regression tests, fix the production path, run tests, obtain independent review, fix findings, rerun checks, commit atomically, merge through normal `gh ship`, then verify the exact deployed revision.
- Calendar data repair is not proof that the bot is fixed. Check authoritative tool results, database changes, synchronization and actual delivery separately. Never report a created invitation as delivered or a declined attendance as event deletion.
- Never rerun completed writes merely to repair an explanation. Preserve durable execution evidence across provider changes and retries. Unknown completion is not failure and must not trigger blind replay.
- Validate the exact pull-request head with `bun test`, typecheck and `bun run lint`. Preserve disclosed skips. Use normal local CI fallback when hosted CI is unavailable; do not bypass real failures or manufacture successful checks.
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
