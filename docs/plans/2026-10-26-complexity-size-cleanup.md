# Complexity and file-size cleanup

Date: 2026-10-26. Status: remaining acceptance work is tracked below and in the pull request.
Tracking issue: [#860](https://github.com/alex-mextner/HyperCalendarBot/issues/860)

## Goal

Make two limits enforceable across the repository and bring the current tree under them without
changing runtime behavior, public exports, import paths, tests or data.

## Policy

- Function complexity, measured by [moznion/cccc](https://github.com/moznion/cccc): cognitive
  complexity <= 15 and cyclomatic complexity <= 20 per function.
- Physical file size: <= 1200 lines OK, > 1200 lines warning, > 2400 lines error.
- Exempt from the size rule: `.json` files only (`exempt_extensions` in `rig.yaml`), plus binaries and
  git-ignored files. Generated lockfiles remain measured. The former `uv.lock` warning is addressed
  by a native universal `requirements.lock` migration; no lockfile exemption or manual compaction is used.
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


## Follow-up verification — 2026-10-29 (#860)

The starting main is `bb7a9d4765e406b3c2c258fc4ad55445643857ac` (tree
`b487d260a352a3fadcf862aa5c4fdd5354e05ed0`). Only criterion 4 was complete at
the handoff; the hosted 8,585-test pass is not the required final server proof.

- [x] Find a native, dependency-preserving replacement for the 1,343-line lock.
  uv 0.12.24's universal requirements format is 942 lines and retains all 55
  package versions, all 803 artifact hashes, the index and equivalent markers
  and extras in every one of 36 marker truth partitions. The Python dependency
  declarations are unchanged. See `docs/reference/python-dependencies.md`.
- [ ] Review and ship the lock migration, then record the physical-line census
  with the exact merged revision, including non-ignored untracked text files.
- [ ] Audit each documentation split against its own original revision, restore
  accidental lost bytes and explicitly list required link retargeting. Preserve
  independently changed product documentation after the split.
- [ ] Preserve original test names and assertions with per-file manifests, and
  run frozen install, full Bun tests, lint and typecheck on server 65.21.40.51
  against the final source-file manifest. Record all skips and environment setup.
- [ ] Capture hosted scratch-branch runs for text at 2,400/2,401 lines, JSON over
  2,400 lines, and the passing branch without the scratch artifacts. Keep the
  deliberate failure out of main and retain the normal review and ship gates.


## Verification evidence — 2026-10-31 (#860)

The owned continuation starts from `bb7a9d4765e406b3c2c258fc4ad55445643857ac`.
The source files and generated outputs below have passed focused verification;
review, the exact final-tree server suite, hosted boundary proof and deployment
remain separate acceptance gates.

| Date | Metric | Result |
| --- | --- | --- |
| 2026-10-31 | Original document content | All 20 plan/spec families mapped with every hunk explicit; four Python fences restored from original bytes; 79 current paths match the recorded source hashes. The original complete Markdown and HTML renderings are byte-identical. All 52 Markdown cards and 52 pretty HTML workflow blocks retain their raw bytes, with 119 Markdown link retargets and 54 HTML relocations listed explicitly. |
| 2026-10-31 | Focused generated-document runtime proof on Home | Frozen install, generation, original-model equality, freshness, actual Chromium with JavaScript-disabled navigation, 26 tests and 1,782 assertions, whole-repository lint and typecheck all passed. Every current generated physical page is at most 961 lines. This is not the required final server 65.21.40.51 full suite. |
| 2026-10-31 | Original split test inventory | All 519 original names are mapped. 513 cases retain byte-identical assertion chains; six fixture/cast/addition differences are explicit. Original assertions 1,493 become 1,545 through 52 added assertions; independent later feature changes are kept separate. The original public-renderer test bodies and browser assertions remain unchanged after formatting. |

Detailed comparisons: [document preservation](../reference/complexity-size-preservation.md),
[byte and line metadata](../reference/complexity-size-preservation.json), and
[original test preservation](../reference/complexity-test-preservation.md).
The Python lock contract and the compiler's hash-validation limitation are documented
in [Python dependency locks](../reference/python-dependencies.md).

The isolated hosted proof branch must never merge. Its workflow generates the
1,200/1,201/2,400/2,401-line text fixtures and the 2,401-line JSON fixture on the runner,
then records native diagnostics and process exits. A verifier failure has its own
exit 90; the verified 2,401-line text case remains a real failed run with native exit 1.
No hosted outcome is claimed until that exact branch revision has actually run.

## Subsequent measurements — 2026-10-31 22:01 UTC

The entries above retain their measurement-time status. The hosted proof has now
completed; the final committed-source full server gate and deployment remain open.

| Date | Metric | Result |
| --- | --- | --- |
| 2026-10-31 | Full server attempt on staged tree `63a891b7705cf4b336270f29d2f039d4ecfa8328` | 8,567 passed, 16 existing Docker-dependent skips, three failed runtime cases across 521 files. Lint, typecheck and generated-document freshness passed. Source files and test inventories were unchanged. The failures were the old lock consumer and two installer fixtures that could not find the server's real Git executable. The failed result is retained. |
| 2026-10-31 | Focused repair proof on server 65.21.40.51 | Both original installer suites pass (24 and 37 tests); the original lock test passes. All 62 names and 273 raw assertion calls/chains remain unchanged. Ruff format/check and Biome pass. Native uv 0.12.24 with Python 3.12.15 produces the same 55 pins, 803 hashes and byte-identical dependency body in 942 lines, with a generated project-version stamp. Wrong-stamp and bump-without-regeneration mutations each fail the real original equality assertion; restored inputs pass. |
| 2026-10-31 | Hosted boundary source | All six actual runs use commit `72da5333259baf9a38958addd9bb89df0ec8f060`, tree `7eeb13f6c1be9cc4db25b626b50998baf8cb52a9`, attempt 1. The isolated branch must never merge. [Public measured evidence](https://github.com/alex-mextner/HyperCalendarBot/issues/860#issuecomment-6549644601). |
| 2026-10-31 | Knip baseline comparison | Knip 6.44.1 reports the same diagnostic bytes on the staged candidate and `bb7a9d4`; both exit 1. A bounded comparison with latest stable 5.x, 5.88.1, also returns byte-identical candidate/base reports and exit 1. Version 5 recognizes the existing `classMembers` configuration, but the older unused-code findings remain. The failed check is tracked by existing [#564](https://github.com/alex-mextner/HyperCalendarBot/issues/564); no public export, rule, ignore entry or tool pin was changed to suppress it. |

| Hosted case | Physical fixture lines | Fixture verdict | Scoped files considered | Native exit | Run |
| --- | ---: | --- | ---: | ---: | --- |
| No scratch fixture | absent | none | — | 0 | [41243872563](https://github.com/alex-mextner/HyperCalendarBot/actions/runs/41243872563) |
| Text at lower boundary | 1200 | no diagnostic or skip | 1 | 0 | [41244033121](https://github.com/alex-mextner/HyperCalendarBot/actions/runs/41244033121) |
| First warning | 1201 | warning, limit 1200 | 1 | 0 | [41244037336](https://github.com/alex-mextner/HyperCalendarBot/actions/runs/41244037336) |
| Upper warning boundary | 2400 | warning, limit 1200 | 1 | 0 | [41244041777](https://github.com/alex-mextner/HyperCalendarBot/actions/runs/41244041777) |
| First error | 2401 | error, limit 2400 | 1 | 1 | [41244046103](https://github.com/alex-mextner/HyperCalendarBot/actions/runs/41244046103) |
| JSON exemption | 2401 | explicit `file_lines` / `exempt-extension` skip | 0 | 0 | [41244050562](https://github.com/alex-mextner/HyperCalendarBot/actions/runs/41244050562) |

Every hosted verifier returned `ok: true`. The text-error run is an actual failed
job with native exit 1 in both repository and fixture-scoped checks, not verifier
exit 90. Thresholds remain 1200/2400 and the sole configured extension exemption
is JSON. The normal task interface accepted only criterion 5 using the documented
textual-CI-proof reason. The issue stays open with criteria 1, 2 and 3 unchecked.
