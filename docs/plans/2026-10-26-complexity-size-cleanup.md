# Complexity and file-size cleanup

Date: 2026-10-26. Status: implemented; review and ship tracked in the pull request.
Tracking issue: [#860](https://github.com/alex-mextner/HyperCalendarBot/issues/860)

## Goal

Make two limits enforceable across the repository and bring the current tree under them without
changing runtime behavior, public exports, import paths, tests or data.

## Policy

- Function complexity, measured by [moznion/cccc](https://github.com/moznion/cccc): cognitive
  complexity <= 15 and cyclomatic complexity <= 20 per function.
- Physical file size: <= 1200 lines OK, > 1200 lines warning, > 2400 lines error.
- Exempt from the size rule: `.json` files only (`exempt_extensions` in `rig.yaml`), plus binaries and
  git-ignored files. `uv.lock` (1343 lines) is a generated lockfile and is NOT exempt: it stays as the one
  reported warning (the checker cannot fix it, and a lockfile is never hand-edited or split).
- Counted: tests, docs and source alike, plus untracked files that are not ignored
  (`git ls-files --cached --others --exclude-standard`).
- Not allowed as a fix: minification, deleting comments/tests/docs content, raising thresholds,
  blanket suppressions, lint-ignore additions, moving content into exempt file types.

## Structure of the work

Wave 1 splits oversized files by cohesive responsibility into well-named modules, each comfortably
<= 1200 lines (aim <= 1000). Every area has one owner with a disjoint file set, working in the shared
worktree `.worktrees/cccc-complexity` (branch `cccc-complexity`); nobody commits, an integrator makes
atomic commits afterwards.

| Area | Files |
| --- | --- |
| Docs plans + specs | oversized `docs/plans/*.md`, `docs/specs/05-image-generation.md`, `docs/specs/03-google-calendar-sync.md` |
| Generated intent docs | `docs/intents/README.md`, `docs/intents/index.html` (and their generator) |
| Callback / message handlers | `src/bot/handlers/callback.handler.ts`, `src/bot/handlers/message.handler.ts`, `test/bot/handlers/message.handler.test.ts` |
| Config constants | `src/config/constants.ts` |
| AI agent + streaming + agent-run test | `src/services/ai/agent.ts`, `src/services/ai/streaming.ts`, `test/services/ai/agent-run.test.ts` |
| Events handler + tool-handler tests | `src/services/ai/tool-handlers/events.ts`, tests `sharing`, `events`, `meta` under `test/services/ai/tool-handlers/` |
| Entry point + canonical basis | `src/index.ts`, `test/regressions/canonical-basis-behavior.test.ts` |
| Plan + ticket | this file and the tracking issue |

Wave 2 handles complexity findings, grouped by source directory, once the Rig shared checker exists
(its contract is expected at `/tmp/rig-cccc-contract.md`). Functions touched or created in wave 1
must already be under both limits.

## Verification plan

- Locally: one test file at a time (`bun test <file>`), `biome check` on the owned files,
  `tsc --noEmit` filtered to the owned files. No full-suite runs on the workstation.
- Full `bun test`, lint and typecheck run on server 65.21.40.51 via ssh as `ultra`, in an isolated
  scratch checkout that excludes secrets, `.env` files and production data.
- Test splits keep every original case (same names, same assertions) and the same `mock.module` setup,
  because bun's `mock.module` is process-global; shared fixtures live in non-`*.test.ts` helper modules.
  Test-case counts are recorded before and after.
- Doc-only splits preserve content verbatim, proven once by a byte/line comparison.
- Size re-measure: the same command as the baseline, over non-`.json` text files.

## Baseline (2026-10-26, main 2327f650f56b09fbb1362891349411af59d1562d)

1049 non-`.json` text files from `git ls-files --cached --others --exclude-standard`.
36 files exceed 1200 lines: 10 errors (> 2400) and 26 warnings.

Errors (10):

| File | Lines |
| --- | --- |
| `docs/intents/README.md` | 5961 |
| `docs/plans/2026-03-13-google-calendar-sync.md` | 3477 |
| `docs/plans/2026-03-25-connect-telegram.md` | 3388 |
| `docs/intents/index.html` | 3339 |
| `docs/plans/2026-03-12-parser-recurrence-holidays.md` | 2897 |
| `docs/plans/2026-03-13-notifications.md` | 2853 |
| `docs/plans/2026-03-13-ai-agent.md` | 2801 |
| `test/services/ai/agent-run.test.ts` | 2684 |
| `docs/plans/2026-03-20-ai-assistant-bot-server.md` | 2534 |
| `src/bot/handlers/callback.handler.ts` | 2469 |

Warnings (26), written as `file lines`:

- `src/config/constants.ts` 2288; `test/services/ai/tool-handlers/sharing.test.ts` 2247
- `src/services/ai/agent.ts` 1873; `src/services/ai/streaming.ts` 1418; `src/index.ts` 1342
- `src/bot/handlers/message.handler.ts` 1241; `test/bot/handlers/message.handler.test.ts` 1253
- `src/services/ai/tool-handlers/events.ts` 1225; `test/services/ai/tool-handlers/events.test.ts` 1486
- `test/services/ai/tool-handlers/meta.test.ts` 1215; `test/regressions/canonical-basis-behavior.test.ts` 1249
- `uv.lock` 1343 (generated lockfile; counted, and the only file still above 1200 after the cleanup)
- Plans in `docs/plans/`: `2026-03-13-image-generation.md` 2199, `2026-03-19-bidirectional-voice.md` 2154,
  `2026-03-19-scheduled-ai-calls.md` 2143, `2026-03-21-stt-corrections.md` 2025,
  `2026-03-17-bot-ux-automation.md` 1781, `2026-03-17-group-chat-interaction.md` 1779,
  `2026-03-16-voice-call-reminders.md` 1774, `2026-03-20-birthdays.md` 1693,
  `2026-04-10-openai-sdk-migration.md` 1555, `2026-03-18-invite-propose-time.md` 1534,
  `2026-03-18-secretary-access.md` 1439, `2026-03-18-group-commands.md` 1258
- Specs in `docs/specs/`: `05-image-generation.md` 1277, `03-google-calendar-sync.md` 1234

## Results

Append-only: one dated row per measurement, never edit earlier rows.

| Date | Metric | Result |
| --- | --- | --- |
| 2026-10-26 | File-size baseline at main 2327f650 | 36 files > 1200 lines: 10 errors, 26 warnings (listed above) |
| 2026-10-26 | Complexity baseline (cognitive > 15, cyclomatic > 20), recursive over nested functions | 163 violating functions in 101 files (coordinator count; the immutable scan kept with the evidence lists 209 over-limit functions over 893 analysed files, a different enumeration) |
| 2026-10-26 | Complexity after the cleanup | 0 violations over 1109 files, nested functions included, no suppressions, exclusions or raised thresholds |
| 2026-10-26 | File size after the cleanup | 0 errors; the only file above 1200 lines is `uv.lock` (1343, generated lockfile, reported as a warning) |
