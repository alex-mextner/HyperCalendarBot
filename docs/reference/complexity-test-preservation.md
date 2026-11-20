# Original test-name and assertion preservation for #860

Original baseline and actual split parent: `2327f650f56b09fbb1362891349411af59d1562d`. Split: `0bdc82291b2241b07279814be389b537c1618887`. Current committed source inspected: `bb7a9d4765e406b3c2c258fc4ad55445643857ac`. This is source preservation evidence; the required final committed-tree full Bun run on 65.21.40.51 is a separate gate.

## Result at the split

All **519 original `test`/`it` declarations retain their original title**. The original 519 declarations contain 1493 complete outer `expect`/`assert` chains. There are 540 declarations after the split: the 21 additions are new events-write-path tests. Their 50 assertions and two added message checks account for 1493→1545. Outside-test assertions are 5 → 6; every original remains.

**513 cases have byte-identical assertion chains.** The remaining 6 message cases have the explicit source maps below; five change a fixture reference or remove an erased TypeScript cast, and one keeps its original assertion and adds two. The audit does not call those raw or AST-identical.

The TypeScript AST audit records declaration titles, suite ancestry, complete test bodies, raw source SHA-256, AST SHA-256, and complete outer assertion invocations. It counts source declarations, not runtime expansions of `each`. Raw hashes never remove whitespace, casts, banners or other source text.

## Before/after counts per file

| Original file | Cases | Assertions in cases |
|---|---:|---:|
| [`test/services/ai/agent-run.test.ts`](https://github.com/alex-mextner/HyperCalendarBot/blob/2327f650f56b09fbb1362891349411af59d1562d/test/services/ai/agent-run.test.ts) | 92 | 332 |
| [`test/services/ai/tool-handlers/sharing.test.ts`](https://github.com/alex-mextner/HyperCalendarBot/blob/2327f650f56b09fbb1362891349411af59d1562d/test/services/ai/tool-handlers/sharing.test.ts) | 97 | 321 |
| [`test/services/ai/tool-handlers/events.test.ts`](https://github.com/alex-mextner/HyperCalendarBot/blob/2327f650f56b09fbb1362891349411af59d1562d/test/services/ai/tool-handlers/events.test.ts) | 78 | 198 |
| [`test/bot/handlers/message.handler.test.ts`](https://github.com/alex-mextner/HyperCalendarBot/blob/2327f650f56b09fbb1362891349411af59d1562d/test/bot/handlers/message.handler.test.ts) | 66 | 123 |
| [`test/regressions/canonical-basis-behavior.test.ts`](https://github.com/alex-mextner/HyperCalendarBot/blob/2327f650f56b09fbb1362891349411af59d1562d/test/regressions/canonical-basis-behavior.test.ts) | 69 | 223 |
| [`test/services/ai/tool-handlers/meta.test.ts`](https://github.com/alex-mextner/HyperCalendarBot/blob/2327f650f56b09fbb1362891349411af59d1562d/test/services/ai/tool-handlers/meta.test.ts) | 117 | 296 |

| Destination file at the split | Cases | Assertions in cases |
|---|---:|---:|
| [`test/services/ai/agent-run-conversation.test.ts`](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/test/services/ai/agent-run-conversation.test.ts) | 21 | 68 |
| [`test/services/ai/agent-run-day-guards.test.ts`](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/test/services/ai/agent-run-day-guards.test.ts) | 9 | 25 |
| [`test/services/ai/agent-run-errors-and-budgets.test.ts`](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/test/services/ai/agent-run-errors-and-budgets.test.ts) | 12 | 39 |
| [`test/services/ai/agent-run-execution-log.test.ts`](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/test/services/ai/agent-run-execution-log.test.ts) | 6 | 19 |
| [`test/services/ai/agent-run-helpers.ts`](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/test/services/ai/agent-run-helpers.ts) | 0 | 0 |
| [`test/services/ai/agent-run-invitations-and-delivery.test.ts`](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/test/services/ai/agent-run-invitations-and-delivery.test.ts) | 8 | 40 |
| [`test/services/ai/agent-run-tool-exposure.test.ts`](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/test/services/ai/agent-run-tool-exposure.test.ts) | 16 | 61 |
| [`test/services/ai/agent-run-tool-results.test.ts`](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/test/services/ai/agent-run-tool-results.test.ts) | 6 | 13 |
| [`test/services/ai/agent-run-write-guards.test.ts`](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/test/services/ai/agent-run-write-guards.test.ts) | 14 | 67 |
| [`test/services/ai/tool-handlers/sharing-agenda-visibility-proposals.test.ts`](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/test/services/ai/tool-handlers/sharing-agenda-visibility-proposals.test.ts) | 33 | 102 |
| [`test/services/ai/tool-handlers/sharing-invitation-status.test.ts`](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/test/services/ai/tool-handlers/sharing-invitation-status.test.ts) | 34 | 132 |
| [`test/services/ai/tool-handlers/sharing.test.ts`](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/test/services/ai/tool-handlers/sharing.test.ts) | 30 | 87 |
| [`test/services/ai/tool-handlers/events-group-scope.test.ts`](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/test/services/ai/tool-handlers/events-group-scope.test.ts) | 26 | 81 |
| [`test/services/ai/tool-handlers/events-participants.test.ts`](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/test/services/ai/tool-handlers/events-participants.test.ts) | 5 | 15 |
| [`test/services/ai/tool-handlers/events-write-paths.test.ts`](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/test/services/ai/tool-handlers/events-write-paths.test.ts) | 21 | 50 |
| [`test/services/ai/tool-handlers/events.test.ts`](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/test/services/ai/tool-handlers/events.test.ts) | 47 | 102 |
| [`test/bot/handlers/message-handler-location.test.ts`](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/test/bot/handlers/message-handler-location.test.ts) | 10 | 31 |
| [`test/bot/handlers/message-handler-units.test.ts`](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/test/bot/handlers/message-handler-units.test.ts) | 19 | 37 |
| [`test/bot/handlers/message.handler.test.ts`](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/test/bot/handlers/message.handler.test.ts) | 37 | 57 |
| [`test/regressions/canonical-basis-behavior.test.ts`](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/test/regressions/canonical-basis-behavior.test.ts) | 28 | 75 |
| [`test/regressions/canonical-basis-helpers.ts`](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/test/regressions/canonical-basis-helpers.ts) | 0 | 0 |
| [`test/regressions/canonical-basis-sqlite-plans.test.ts`](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/test/regressions/canonical-basis-sqlite-plans.test.ts) | 24 | 88 |
| [`test/regressions/canonical-basis-sqlite-writes.test.ts`](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/test/regressions/canonical-basis-sqlite-writes.test.ts) | 17 | 60 |
| [`test/services/ai/tool-handlers/meta-calculate.test.ts`](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/test/services/ai/tool-handlers/meta-calculate.test.ts) | 33 | 72 |
| [`test/services/ai/tool-handlers/meta-timezone.test.ts`](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/test/services/ai/tool-handlers/meta-timezone.test.ts) | 28 | 71 |
| [`test/services/ai/tool-handlers/meta.test.ts`](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/test/services/ai/tool-handlers/meta.test.ts) | 56 | 153 |

The old destination map accidentally omitted `agent-run-tool-results.test.ts`. The earlier broad AST scan found all six cases there. The narrow follow-up compared all thirteen assertion source strings directly against the original; every one matches. This is a map repair, with no test-source edit.

## Six explicit message assertion maps

### uses primary sileroTts when available

[Original L1087](https://github.com/alex-mextner/HyperCalendarBot/blob/2327f650f56b09fbb1362891349411af59d1562d/test/bot/handlers/message.handler.test.ts#L1087) → [destination L132](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/test/bot/handlers/message-handler-units.test.ts#L132). The `synthesize` variable is passed as the supplied property of the strict proxy; `stub` returns that supplied property through `Reflect.get` without wrapping it. Both assertions observe the same mock. The `sendVoice` cast is erased by TypeScript.

```diff
-expect(sileroTts.synthesize).toHaveBeenCalledTimes(1)
-expect((deps as never as { sendVoice: ReturnType<typeof mock> }).sendVoice).toHaveBeenCalledTimes(1)
+expect(synthesize).toHaveBeenCalledTimes(1)
+expect(deps.sendVoice).toHaveBeenCalledTimes(1)
```

### falls back to fallbackTts when primary sileroTts throws

[Original L1099](https://github.com/alex-mextner/HyperCalendarBot/blob/2327f650f56b09fbb1362891349411af59d1562d/test/bot/handlers/message.handler.test.ts#L1099) → [destination L143](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/test/bot/handlers/message-handler-units.test.ts#L143). Only the erased `sendVoice` type cast changes in the assertions. The new typed dependency fixture also rejects unstubbed property reads.

```diff
-expect((deps as never as { sendVoice: ReturnType<typeof mock> }).sendVoice).toHaveBeenCalledTimes(1)
+expect(deps.sendVoice).toHaveBeenCalledTimes(1)
```

### uses fallbackTts when no primary TTS configured

[Original L1110](https://github.com/alex-mextner/HyperCalendarBot/blob/2327f650f56b09fbb1362891349411af59d1562d/test/bot/handlers/message.handler.test.ts#L1110) → [destination L153](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/test/bot/handlers/message-handler-units.test.ts#L153). Only the erased `sendVoice` type cast changes in the assertions.

```diff
-expect((deps as never as { sendVoice: ReturnType<typeof mock> }).sendVoice).toHaveBeenCalledTimes(1)
+expect(deps.sendVoice).toHaveBeenCalledTimes(1)
```

### sends no voice when no TTS configured at all

[Original L1119](https://github.com/alex-mextner/HyperCalendarBot/blob/2327f650f56b09fbb1362891349411af59d1562d/test/bot/handlers/message.handler.test.ts#L1119) → [destination L162](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/test/bot/handlers/message-handler-units.test.ts#L162). The original no-voice assertion is unchanged. Two additional assertions check the single transcription-echo message and its content.

```diff
+expect(ctx.send).toHaveBeenCalledTimes(1)
+expect(ctx.send.mock.calls[0]?.[0]).toContain('Пользователь говорит')
```

### uses fallbackTts for EN when kokoroTts throws

[Original L1127](https://github.com/alex-mextner/HyperCalendarBot/blob/2327f650f56b09fbb1362891349411af59d1562d/test/bot/handlers/message.handler.test.ts#L1127) → [destination L174](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/test/bot/handlers/message-handler-units.test.ts#L174). Only the erased `sendVoice` type cast changes in the assertions. The English fallback call still receives the same string matcher and language.

```diff
-expect((deps as never as { sendVoice: ReturnType<typeof mock> }).sendVoice).toHaveBeenCalledTimes(1)
+expect(deps.sendVoice).toHaveBeenCalledTimes(1)
```

### passes userMemoryRepo into AgentContext

[Original L1238](https://github.com/alex-mextner/HyperCalendarBot/blob/2327f650f56b09fbb1362891349411af59d1562d/test/bot/handlers/message.handler.test.ts#L1238) → [destination L283](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/test/bot/handlers/message-handler-units.test.ts#L283). The same repository object is compared by identity; the removed `as never` cast has no runtime effect.

```diff
-expect(ctx.birthday?.userMemoryRepo).toBe(userMemoryRepo as never)
+expect(ctx.birthday?.userMemoryRepo).toBe(userMemoryRepo)
```

The original outside-test `expect(ctx.send).toHaveBeenCalledTimes(1)` is unchanged in the location helper. A new callback-response assertion accounts for the one added outside-test chain.

## Independent later feature changes

The original split preserved all 69 canonical-basis cases and all their assertion bytes. Commit [`366918fe29d83abf8919b0d649b0d06b5952fca1`](https://github.com/alex-mextner/HyperCalendarBot/commit/366918fe29d83abf8919b0d649b0d06b5952fca1) (#859) then changed the seed contract. The exact commit diff accounts for all 10 changed same-title assertion chains and 5 renamed cases; there is no later history in these three files through `bb7a9d4765e406b3c2c258fc4ad55445643857ac`. These are retained feature changes, not split losses.

| Original title | Later #859 title |
|---|---|
| every private rule refuses in a group before any tool runs | every private rule refuses or steps aside in a group before any tool runs |
| a single day of free time defaults to today | a bare question without a day goes to the AI; with "сегодня" it reads today |
| a title that matches nothing stops without a write | a title that matches nothing stops without a write and hands the message to the AI |
| a rescheduled event that has an end time is refused instead of corrupted | a rescheduled event that has an end keeps its length: both ends move, after the user says yes |
| renaming needs a number or quoted title and asks first | renaming asks first, by title or by number |

The ten same-title changes cover the explicit Saturday ambiguity guard, create-and-invite two-write contract, displayed date labels, title capitalization, and standalone reminder output. The five renamed cases cover group abstention, explicit-day free-time queries, no-match handoff to AI, preserving an event duration when moving both ends, and confirmation when renaming by an unquoted title. No later feature test was rolled back.

## Durable evidence and remaining runtime gate

The full AST artifacts retain every original case and assertion, not only these exception tables. The initial broad scan and the corrected narrow scan remain separate; no failed or incomplete audit is overwritten. The six omitted-destination case matches and this exact count summary are recorded in the retained machine-readable assertion manifest. The final source SHA/tree and tracked file manifest will be attached to the actual 65.21.40.51 full frozen-install/lint/typecheck/Bun-test run. A hosted pass or Home subset pass does not replace that requirement.

## Lock consumer and installer fixture portability — 2026-10-31

The full server run on staged tree `63a891b7705cf4b336270f29d2f039d4ecfa8328`
reported 8,567 passed, 16 skipped and three failed runtime cases. Both installer
regression suites hid the server's real Git executable outside the system PATH;
the lock test still read the replaced `uv.lock`. All input source files and the
before/after test inventory remained unchanged during that run.

| Existing test file | Original names retained | Original raw assertion calls retained |
|---|---:|---:|
| `test/scripts/python-lock.test.ts` | 1 | 2 |
| `test/python/test_odroid_stage_qa_installer.py` | 24 | 91 |
| `test/python/test_stage_qa_browser_installer.py` | 37 | 180 |

The lock test keeps its historical title and both original assertion chains. Its
stored-version input now comes from uv's generated requirements header. The
generator stamps the actual project version only when it runs; the test reads
that stored stamp independently. On the server, a wrong stored stamp and a
version bump without regeneration each made the original equality assertion fail
with exit 1. Restoring the inputs returned the test to green. A copied compiler
command with a stale explicit version exits 2 before modifying the lock.

Each installer fixture resolves the real Git executable before constructing its
restricted PATH, then exposes only that executable in its private temporary bin.
The root installer already resets PATH internally, so its test copy uses the
existing fixture mechanism for rewriting the fixed `SAFE_PATH` constant. The
production installers and all security assertions are unchanged. The 24 and 37
original Python tests pass on server 65.21.40.51 with these fixtures.

Focused checks used Bun 1.4.2, uv 0.12.24 with Python 3.12.15 for generation, and
the server's Python 3.14.4 and Git 2.56.0 for the installer suites. All 55 package
pins, 803 artifact hashes and every dependency-body byte remain identical;
regeneration is idempotent and the lock remains 942 physical lines. These focused
results do not replace the required full run on the final committed source.

## Files that grew past 1,200 lines after the split — 2026-11-07

Main `78b63430374b799d176978fa1edfb7391ca5af8a` carries three non-JSON files that
upstream feature work took over the 1,200-line limit after `bb7a9d4765e4`. They are
split here without minifying, without an exemption and without a threshold change.
Moved code is byte-identical; the only edits inside a moved test body are listed below.

| Original file | Lines | Cases | Outer `expect` chains |
|---|---:|---:|---:|
| `test/services/ai/write-receipt.test.ts` | 1,997 | 139 | 212 |
| `test/scripts/hcb-alert-watcher.test.ts` | 1,477 | 72 | 267 |
| `src/database/repositories/event.repository.ts` | 1,212 | not a test file | not applicable |

| Destination | Lines | Cases | Outer `expect` chains |
|---|---:|---:|---:|
| `test/services/ai/write-receipt.test.ts` | 920 | 64 | 105 |
| `test/services/ai/write-receipt-ledger.test.ts` | 531 | 38 | 56 |
| `test/services/ai/write-receipt-updates.test.ts` | 505 | 37 | 51 |
| `test/services/ai/write-receipt-helpers.ts` (shared fixtures) | 120 | 0 | 0 |
| `test/scripts/hcb-alert-watcher.test.ts` | 837 | 48 | 159 |
| `test/scripts/hcb-alert-watcher-incidents.test.ts` | 513 | 24 | 108 |
| `test/scripts/hcb-alert-watcher-harness.ts` (shared fixtures) | 200 | 0 | 0 |
| `src/database/repositories/event.repository.ts` | 1,162 | not a test file | not applicable |
| `src/database/repositories/event-duplicate-match.ts` | 56 | not a test file | not applicable |

The same TypeScript AST collector used above matched all 211 original cases by suite
ancestry, title and occurrence: none is missing and none was added, all 479
`expect` chains keep their raw bytes, and 208 of 211 callback bodies are byte-identical.
The three that differ are in `hcb-alert-watcher.test.ts`: a test that points the
watcher at its own fake server assigned the shared `server` binding, which an
importing module cannot do, so `server = Bun.serve({…})` became
`replaceServer(Bun.serve({…}))`. Those cases are *a queue that keeps answering 200
with a page instead of JSON…*, *a queue host that redirects does not receive the
alert token* and *a 200 the watcher cannot read is saved, not lost…*; their
assertions are unchanged. Each test file calls `useWatcherHarness()` once, which
registers the same `beforeEach`/`afterEach` hooks the original registered at its top
level; the write-receipt files repeat the original two clock hooks.

Runtime check on the integrated tree (`bun test` of the original files from main under
temporary names, then of the split files): 331 tests passed before and 331 after, with
0 failures. The 835 tests under `test/services/event` and `test/database`, which
exercise `EventRepository`, also passed. `event.repository.ts` keeps `EventRepository`,
its exported constants and the `CreateOutcome` type; the type is re-exported so the
existing import in `src/services/event/event-service.ts` is unchanged. The per-case
hashes, line numbers and destination map are in
[`complexity-size-preservation-upstream-splits.json`](complexity-size-preservation-upstream-splits.json).

## Project version stamp — 2026-11-07

Main moved the project version from 0.2.122 to 0.3.6 while this change was open.
The migration bumps it once more to 0.3.7, and `requirements.lock` was regenerated with
`python3 scripts/compile-python-lock.py`: only the one-line command header changed
(`--project-version 0.3.7`); all 942 lines of dependency body are byte-identical.
