# Chat incident closeout — 2026-09-18

Parent audit: #241. Scope: failures seen in the two requested private bot conversations, correlated with Docker logs, chat history and read-only database state. Private messages, medical event titles, credentials and raw log archives must not be committed.

## Fresh evidence and causal chain

The September 18 batch had six requested events. One generated owner ID differed from the resolved ID; secretary authorization correctly refused it. A different create call supplied timezone-conversion prose as `start_at`. The old schema accepted any string. `NaN < now` did not trigger the past-event guard. SQLite inserted the row before downstream formatting/materialization raised `Invalid Date`. A valid replacement was then created. Read-only inspection found six valid rows plus one active malformed row; the uncertainty receipt was justified for the failed attempt, not evidence of an absent write.

The initial runtime checkpoint still showed the container started on September 15 while main had advanced to `8f090f2`. Both health and readiness answered `ok`; neither proves deployment of an incident fix. Deployment must be verified by immutable revision/image evidence.

## Priority and existing work

| Priority | Class | Existing work | Acceptance gate |
| --- | --- | --- | --- |
| P0 | Invalid timestamp persisted before failure | #295 | Reject before SQL through schema, direct handlers and repository; valid dates/offsets/null end deletion remain supported. |
| P0 | Malformed orphan after a repaired create | #295 | Explicit inspected pair, current fingerprints, private verified backup, no external/dependent rows, one reversible soft-delete, all other event rows unchanged. Never replay the batch. |
| P0 | Unsupported final answer after validator rejection | #284; earlier #288 | No twice-rejected final response/history; retain actual write evidence and clarification UI; original writes are not requeued for explanation repair. |
| P0 | Recipient identity and authorization | #255 / #221 / #222 / #232 / #243 | Resolve stable IDs, preserve owner-scoped contact operations and authorization. A generated wrong owner must remain denied. Preserve the active contact worktree; no competing identity implementation. |
| P1 | Time-button callback truncates a colon value | #277 / #278 | Private time values round-trip unchanged; group callback authorization remains enforced. |
| P1 | Quota noise and exhausted providers repeatedly selected | #277 / #226 | One incident notice, honest reset/recovery information, no repeated impossible provider calls; keep ordinary fast paths measured. |
| P1 | Successful invitation rendered as implementation receipts | #280 / #279 | Successful delivery gets a concise confirmation; partial/unknown delivery is never described as delivered. |
| P1 | Lost debug evidence due to runtime directory ownership | #282 / #290 / #281 | App uid can write data and logs after repeatable deployment; logging failure is visible and nonfatal. |
| P1 | Calculator datetime contract mismatch | #286 / #283 | Canonical ISO inputs, actionable error, no silent timezone inference. Distinct from numeric arithmetic #262/#263. |
| P1 | Models/transcript/payload latency | #226 / #256 / #257 / #258 / #259; PRs #260/#267/#261/#293 | Merge coordinated existing work, preserve provider metadata, measure actual live latency/token/fallback data. Passing an estimator test is not a latency result. |
| P1 | Unfinished reflection / misleading completion | #231 / #274 | Finish from recorded execution outcomes, never replay uncertain writes; preserve the active reflection worktree. |
| P2 | Missing shared MTProto identity / birthday sync | #285 / #287 | Keep shared consumers fail-closed until an explicitly designated service identity and matching session are provisioned. Do not borrow a personal session. |
| P0 | Merged changes not present in production | #294 / #202 | Standard shipping, reviewed local-build fallback, exact target revision, migration-aware rollback, no database snapshot restoration over newer user writes. |

## Verification sequence

1. Reproduce each concrete defect before patching with synthetic fixtures and actual SQLite assertions.
2. Run the pinned Bun 1.3.11 suite, TypeScript and Biome on each candidate and on the integrated release tree.
3. Run independent role-based review on the complete diff, address concrete findings and re-run affected gates. Headless CLI invocations must close stdin (`</dev/null`) so they do not wait on an interactive tool pipe.
4. Ship through the repository's normal path. Coordinate with `logs/finish-20260918/deployment-stage.lock`; never race an existing production rollout or alter another agent's worktree.
5. Inspect the release receipt, actual container image/revision, readiness and fresh target-chat logs. Keep local tests, deployed code and real Telegram acceptance as separate statuses.
6. Run real Telegram acceptance through an authorized session. A logged-out qa-cli session is not a passed or failed bot scenario; it is an authentication blocker.

## Deliberately open boundaries

#284 additionally needs evidence that covers the correct owner, date range, successful result and completeness of the requested calendar scope. A tool name alone is insufficient. Provisional streaming before validation is a distinct delivery boundary; a corrected final edit is not proof that no unverified fragment was ever briefly visible.

The quarantine command is not fuzzy deduplication. An operator must review the source conversation and select exact candidate/replacement IDs. Inspection emits no event prose. Apply requires fingerprints, a new backup path and explicit `--apply`. It refuses valid or parseable legacy candidates (normalization is a separate review), changed rows, cross-owner/group scope, recurrence, Google synchronization evidence and any foreign-key dependents. It never changes the replacement time/title, creates an event or restores a database snapshot.

Completion must be recorded by dated test/review/deployment/acceptance receipts in the linked issues. Do not close the parent audit, identity, runtime-routing or service-account work merely because the bounded fixes are merged.
