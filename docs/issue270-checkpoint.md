# Issue270 local implementation and integration notes

Scope: this worktree only; synthetic fixtures, in-memory SQLite and scripted model/sender adapters. No external services, commits, pushes, or completion-recovery worktree changes.

## Changes

- `numeric-id.ts` accepts only canonical signed decimal integer strings that fit a safe JavaScript integer. Invalid strings retain their type and fail numeric schema validation. Numeric ID validators require safe integers; signed IDs remain allowed where the existing field allowed them. Optional fields remain optional. String IDs, arbitrary passthrough fields, nested data and non-ID numbers are not coerced.
- Each declared numeric ID field uses the normalization fragment in `tool-schemas.ts`. Validation happens before dispatch and throttle key construction. `tools.ts` is unchanged; advertised schemas stay numeric.
- Agent deduplication uses successfully validated values, so numeric and string representations cannot replay a successful write later in the same run.
- `WriteOutcomes` is a pure per-run ledger. The agent supplies the existing action-log write classification. Results are recorded only after real dispatcher calls, never by interpreting model prose or duplicate markers. The helper does not execute tools, enqueue retries, or import the agent.
- Delete/update identity is the event ID. Invitation identity also includes recipient ID (authoritative over an accompanying username), or the supplied username. Other writes use ID/action fields when available, otherwise exact top-level arguments. Unknown targets and username-to-ID aliases are not guessed from prose.
- Latest result for a matching operation/target supersedes earlier attempts. If unresolved failures remain, final model narration is replaced with deterministic completed/not-completed lines, including persisted final assistant text. Normal execution and response-validation retry share the ledger. Stop-loop controls and supplement silence retain their existing paths.

## Completion-recovery integration

Keep this helper independent when combining with the separate completion-recovery work. Pass the same ledger through execution and validation retries; record actual dispatcher results once. Apply its final notice before final assistant persistence, without executing or recovering writes. Do not append a notice after successful `ask_user`, `end_conversation`, or supplement stop paths. This ledger is intentionally run-local; it does not claim durable exactly-once execution across queued retries or process restarts.

## Evidence checkpoint

Pinned local binary: `/private/tmp/bunx-501-bun@1.3.11/node_modules/.bin/bun` (`1.3.11`).

- First valid red run: 86 pass / 9 fail across dispatcher + schema suites. All three requested string-ID writes failed before normalization; unsafe numeric IDs were also accepted incorrectly.
- Narration red: 33 pass / 1 fail; the real agent returned the scripted success claim after a failed delete.
- Identity red: 9 pass / 2 fail for numeric/string dedup and invitation correction with an added username.
- Failed-create guard: 1 expected failing test before extending agent classification beyond the three target-specific operations.
- Test fixtures count actual SQLite update/delete triggers and invitation rows, including repeated calls and denied owners.
- Final targeted tests, typecheck and lint results are recorded below after completion.

An initial command using `--coverage=false` failed on Bun CLI syntax before running tests; it is not counted as red evidence. One new ask_user test initially lacked a synthetic buttons sender; that fixture was corrected without changing production control behavior.

## Exact changed files

Production: `src/services/ai/numeric-id.ts`, `src/services/ai/tool-schemas.ts`, `src/services/ai/tool-executor.ts`, `src/services/ai/write-outcomes.ts`, `src/services/ai/agent.ts`.

Tests: `test/services/ai/tool-schemas.test.ts`, `test/services/ai/tool-executor.test.ts`, `test/services/ai/write-outcomes.test.ts`, `test/services/ai/agent-run.test.ts`, `test/services/ai/tool-call-key.test.ts`.

Notes: `docs/issue270-checkpoint.md`.

An additional red regression caught lost failed-action logging when validation moved ahead of throttling (expected one log entry, received zero). Validation failures now bypass throttling and handlers but still follow the existing failed-action logging path.

## Final verification

- Bun 1.3.11 targeted tests: **330 passed, 0 failed**, 1,391 assertions across 9 files (4.61s), exit 0. Suites: tool-executor, tool-schemas, agent-run, write-outcomes, tool-call-key, agent-failure-notice, tool-handlers/events, tool-handlers/sharing, tools.
- Bun 1.3.11 running `node_modules/typescript/bin/tsc --noEmit`: exit 0, no diagnostics.
- Bun 1.3.11 `run lint`: exit 0, 630 files checked, no fixes or diagnostics.
- `git diff --check`: exit 0.
- Logs: `/private/tmp/issue270-final-tests.log`, `/private/tmp/issue270-final-tsc.log`, `/private/tmp/issue270-final-lint.log`. Red evidence: `/private/tmp/issue270-red.log`, `/private/tmp/issue270-ledger-red.log`, `/private/tmp/issue270-identity-red.log`, `/private/tmp/issue270-create-red.log`, `/private/tmp/issue270-actionlog-red.log`.
- No external service calls, commit, push, or other worktree operations were performed. No active implementation jobs remain.
