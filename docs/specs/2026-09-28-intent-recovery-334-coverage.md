# GH-334 Scope 5: retained-corpus coverage, honest measurement and natural entry rules

Status: draft for review (2026-09-28). Task: GH-334. Implemented by PR-0 (simulator, coverage
harness, methodology, anonymized fixtures) and PR-7 (natural entry recognizers and seeds). Contextual
coverage comes from PR-6. The simulator is also the server-side `simulate` stage of PR-2.

## Baseline (reproduced)

`scripts/replay-intent-corpus.ts` over the private 402-message corpus on main 7399876e, seed
fingerprint `66274f69...`, 52 rules: matched 18 / 402, bindings valid 18, ambiguous 0, abstained 384.
This counts syntactic routing plus binding replay, not correct behavior. Details and provenance gaps:
`logs/intent-resume-20260927-chatgpt-334/evidence-audit/REPORT.md` (private, not in git).

Independent Opus labels over the same 402 cases: direct 187, contextual 115, clarification 56,
out_of_scope 24, sensitive 11, unsupported 9. Each label carries `family`, `expectedTools`,
`idealResponse`, `needsContext`. The batch starting at case 250 was rewritten after a failed run with
no receipt for the rerun; those 25 labels are reported under "label provenance unverified" until
relabelled.

## What counts

A case is **covered** only when all hold, measured by the simulator (not by the matcher alone):
- its label class is `direct` or `contextual`;
- exactly one rule matched and its typed bindings evaluated at the case's own time and zone;
- the simulated run used tools whose families equal the label's `expectedTools` families (reads
  exact; writes only after the rule asked for confirmation, which the harness answers "yes" once).
  For a write label only the families of the applied writes are compared; reads around the write do
  not matter. Families group `get_events`/`get_upcoming`/`search_events`/`get_event` and the
  `render_*` tools; `ask_user`, `pick_users`, `end_conversation` and `set_reaction` are ignored;
- write outcome is `none` for reads and `applied` for confirmed writes; no external effect was blocked;
- the reply is non-empty and passes the grounding check (every date and time it contains appears
  in a tool result of the same run, in the case's zone, in the calendar after the run, or is the
  case clock). Titles are not checked by the implementation (PR-0): extracting a title from free
  text is not reliable enough to fail a case on.

Every other outcome goes to exactly one separate bucket and never into the numerator:

| Bucket | Meaning |
| --- | --- |
| `correct_clarification` | rule asked a clarifying question for a `clarification`-class case |
| `missing_context` | contextual case whose prior context could not be reconstructed (`contextRecovered=false`) or the reference resolved `none/stale/gone`. Until PR-5 (#557) gives rules a reference store, every contextual case is `missing_context` without simulation |
| `ambiguous` | matcher reason `ambiguous`, or the reference resolved `choices` |
| `unsafe` | a write without confirmation, a blocked external effect, or a write for a read-labelled case |
| `wrong_behavior` | matched but tools, outcome or grounding differ from the label |
| `abstained` | matcher reason `no_match` or `input_too_long` (falls to AI) |
| `missing_capture` | matcher reason `missing_capture`: a rule's pattern applied but a required fragment was absent |
| `excluded_sensitive` | sensitive-labelled cases; never simulated |
| `unlabelled` | no independent label exists; simulated for routing, never covered |

The mapping is exhaustive over the matcher's four abstention reasons listed in `docs/intents/engine.md`
(`no_match`, `ambiguous`, `missing_capture`, `input_too_long`); a new reason fails the harness until it
is mapped. The exact bucket keys emitted in JSON are: `covered`, `correct_clarification`,
`missing_context`, `ambiguous`, `unsafe`, `wrong_behavior`, `missing_capture`, `abstained`,
`excluded_sensitive`, `unlabelled`. A question to the user is a suspension without a yes-like
option, a second suspension after the harness's "yes", or a reply ending in "?" from a run that
attempted no write. `out_of_scope` and `unsupported` classes have no success bucket (their correct
outcome is `abstained`); the per-class table reports them separately.

Headline = covered / 402, plus covered per class. The target from GH-334 is about 100 / 402
(20-30 percent); the report states the measured number and never pads it.

## Simulator (`src/services/intent/simulation/`)

```ts
export interface SimulationCase {
  caseId: string; request: string; at: string; timezone: string; language: 'ru' | 'en';
  calendar: SyntheticEvent[];                     // synthetic, per case; never copied from production
}                                                 // `references` arrive with PR-5 (#557)
export interface SimulationOutcome {
  caseId: string;
  routed: { status: 'matched'; intent: string } | { status: 'abstained'; reason: string };
  handled: boolean;                               // false: a matched rule failed and fell to the AI
  tools: { name: string; success: boolean; afterConfirmation: boolean; write: boolean }[];
  writeOutcome: 'none' | 'applied' | 'unknown';
  askedConfirmation: boolean; askedClarification: boolean;
  blockedExternal: string[];                      // effects on other people or outside the process
  stubbed: string[];                              // image rendering, answered by the simulator
  reply: string | null;
  grounding: { grounded: boolean; ungrounded: string[] };
}
export async function simulateCases(rules: readonly CanonicalSeed[], cases: readonly SimulationCase[]): Promise<SimulationOutcome[]>;
```

Implementation uses a fresh in-memory `bun:sqlite` database with `runMigrations`, real repositories,
the real `IntentMatcherLayer`, `IntentExecutor` and `executeTool`, a fake `TelegramSender` that captures
messages, and a guard that returns `{ success: false, error: 'simulation_blocked' }` for tools with
external effects (`send_invitation`, `resend_invitation`, `cancel_invitation`, `notify_participants`,
`share_event`, `share_agenda`, `propose_edit`, `propose_calendar_change`, `manage_secretaries`,
`make_call`, `end_call`, `schedule_ai_call(_cancel)`, `add_trigger`, `remove_trigger`, `send_feedback`).
The sandbox context has no username resolver and no Google repository, so local reads (`find_user`,
Google and Telegram connection status) run against the database. The fake transport is a real GramIO
`Bot` whose `onApiCall` hook answers locally, so the real layer gets a real `MessageContext`.
Image rendering needs a headless browser and is stubbed (`stubbed`, counted as `stubbedRender`). Clock via `setSystemTime` is
not used in production code; the simulator takes `at` and passes it to the executor's time source.
Today neither `IntentExecutor` nor the tool handlers take a clock: executor helpers and handlers such
as `get_upcoming` and the `create_event` past-date gate call `new Date()`/`Date.now()` directly. The
simulator therefore never runs inside the bot process: it runs in a child `bun` process
(`scripts/intent-simulate.ts`, spawned with a bounded timeout by the harness and by PR-2's
`simulate` stage) whose preload module `src/services/intent/simulation/case-clock.ts` replaces the
global clock with one the simulator sets to each case's `at` (a `Proxy` over `Date` that answers
`new Date()`, `Date.now()` and `Date()` from the case clock; `INTENT_SIM_HOST_NOW` fakes the host
clock for tests). No production handler or executor code changes, and the bot process clock is never
touched. The child replaces `fetch`, `Bun.spawn` and `Bun.spawnSync` before any case, so it has no
network and starts no helper process, and opens no file other than its in-memory database.
It never opens the production database.

## Harness and comparison (`scripts/intent-coverage.ts`)

```
bun scripts/intent-coverage.ts --corpus <private cases.json> --labels <private labels dir> \
  [--rules seed | --rules <exported revision body.json>] [--compare <second rules source>] --out <private dir>
```

- Output: `summary.json` (counts only, fingerprints, rule count, bucket totals, per-class table) and
  `cases.jsonl` (case id, bucket, intent, tools; no request text). Written only to the `--out` directory,
  which must be under `logs/` (gitignored) or outside the repository; the script refuses a path inside
  tracked directories.
- `--compare` recreates the lost old-versus-new comparison: per case, bucket under source A and B,
  gained and lost lists by case id.
- Three-way comparison report (`three-way.jsonl`): historical AI answer (from the corpus record),
  simulated intent reply, and the label's `idealResponse` (`idealMissing` when absent, never filled
  from the old answer). Scoring by the rubric shared with PR-2 (`response-quality.ts`) is not in
  PR-0: rows carry `rubric: "unscored"` until PR-2 provides the scorer. The file is private output.
- `--fixtures <file>` runs the committed synthetic fixtures instead of the private corpus; `--rules`
  and `--compare` take `seed` or an exported `replace_all` revision body (an `operations` body is a
  change against a base and is refused). With `--compare`, `summary.json` carries the gained/lost case
  ids and `comparison.jsonl` the per-case bucket changes.
- Calendars: fixtures carry synthetic calendars; the private corpus runs on an empty calendar per case
  (`calendarPolicy` in `summary.json`), so requests that need an existing event cannot be covered yet.
- Label batches whose receipt is not `completed` (the 250 batch) keep provenance `unverified`.
- Contextual cases: the harness builds `SyntheticReference` from the case's `prior` turns only when
  `contextRecovered=true`; otherwise the case is `missing_context` without simulation. Until PR-5
  (#557) every contextual case is `missing_context`.

## Anonymized fixtures (committed)

`test/fixtures/intent-corpus/synthetic-cases.json`: about 60 synthetic cases, at least 6 per class,
written from scratch in Russian and English to exercise the same shapes (terse agenda, day names,
"it"/ordinal references, clarification-worthy requests, out-of-scope, sensitive). No text is copied
or lightly edited from the private corpus; each fixture has `origin: "synthetic"`. A test asserts no
fixture string equals or has normalised edit distance under 0.3 to any string in an optional local
private corpus when that file is present (skipped in CI). `docs/intents/coverage-methodology.md`
(English) describes the buckets, the rubric and how to rerun on the private corpus.

The regression file `test/regressions/corpus-semantic-mismatches.test.ts` in the 2026-09-19 worktree
hardcodes a sentence that likely comes from a real user; when ported it is rewritten as a synthetic
paraphrase with the same structure.

## Natural entry rules (PR-7)

Port `natural-entry.ts` (fixed vocabularies for day names, parts of day, terse agenda forms) and
`seed-natural.ts` from `intent-evolution-release-20260919`, splitting shared hunks of
`workflow-bindings.ts` and `workflow-validator.ts` into this PR. The seed change activates through a
PR-1 source-baseline draft and administrator approval. Rebased after PR #548 for merge coordination only (#548 edits the same
`seed-calendar.ts` notes and `workflow-bindings.ts`; it does not change the catalogue fingerprint). The Unicode title search from the 2026-09-19 worktree is replaced
by the bounded lookup of PR-5.

## Acceptance

PR-0:
1. Simulator on fixtures: a direct read case is `covered`; a write case is `covered` only via the
   confirmation path; a case whose rule calls `send_invitation` is `unsafe` with the tool in
   `blockedExternal`; a contextual case without references is `missing_context`.
2. `--compare seed seed` reports zero gained and zero lost.
3. Running on the private corpus (local, not CI) reproduces 18 matched for the current seed in the
   matcher-only column and reports the new covered number; both go to the private checkpoint.
4. The output directory guard refuses `docs/` and `test/`.
5. No committed file contains a string from the private corpus (checked locally, CI-skipped).
6. Clock: a `get_upcoming` read fixture and a `create_event` write fixture dated 2026-09 produce the
   same outcomes when the child is started under two different host clocks (the test passes a fake host
   time to the child through its preload), and the parent process clock is unchanged.

PR-7:
1. Fixture cases for natural entry move from `abstained` to `covered`; no fixture in another class
   changes bucket.
2. Private corpus rerun: covered count and per-bucket deltas recorded in the checkpoint; gains are
   counted only in the `covered` bucket.
