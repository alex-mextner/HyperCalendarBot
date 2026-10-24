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
  exact; writes only after the rule asked for confirmation, which the harness answers "yes" once);
- write outcome is `none` for reads and `applied` for confirmed writes; no external effect was blocked;
- the reply is non-empty and passes the grounding check (every date, time and title it contains
  appears in a tool result of the same run).

Every other outcome goes to exactly one separate bucket and never into the numerator:

| Bucket | Meaning |
| --- | --- |
| `correct_clarification` | rule asked a clarifying question for a `clarification`-class case |
| `missing_context` | contextual case whose prior context could not be reconstructed (`contextRecovered=false`) or the reference resolved `none/stale/gone` |
| `ambiguous` | matcher reason `ambiguous`, or the reference resolved `choices` |
| `unsafe` | a write without confirmation, a blocked external effect, or a write for a read-labelled case |
| `wrong_behavior` | matched but tools, outcome or grounding differ from the label |
| `abstained` | matcher reason `no_match` or `input_too_long` (falls to AI) |
| `missing_capture` | matcher reason `missing_capture`: a rule's pattern applied but a required fragment was absent |
| `excluded_sensitive` | sensitive-labelled cases; never simulated |

The mapping is exhaustive over the matcher's four abstention reasons listed in `docs/intents/engine.md`
(`no_match`, `ambiguous`, `missing_capture`, `input_too_long`); a new reason fails the harness until it
is mapped. The exact bucket keys emitted in JSON are: `covered`, `correct_clarification`,
`missing_context`, `ambiguous`, `unsafe`, `wrong_behavior`, `missing_capture`, `abstained`,
`excluded_sensitive`.

Headline = covered / 402, plus covered per class. The target from GH-334 is about 100 / 402
(20-30 percent); the report states the measured number and never pads it.

## Simulator (`src/services/intent/simulation/`)

```ts
export interface SimulationCase {
  caseId: string; request: string; at: string; timezone: string; language: 'ru' | 'en';
  calendar: SyntheticEvent[];                     // synthetic, per case; never copied from production
  references?: SyntheticReference[];              // for contextual cases: what the bot "showed" before
}
export interface SimulationOutcome {
  caseId: string;
  routed: { status: 'matched'; intent: string } | { status: 'abstained'; reason: string };
  tools: { name: string; success: boolean; afterConfirmation: boolean }[];
  writeOutcome: 'none' | 'applied' | 'unknown';
  askedConfirmation: boolean; askedClarification: boolean;
  blockedExternal: string[];                      // tools that would reach Telegram users, Google, MTProto or calls
  reply: string | null;
}
export async function simulateCases(rules: readonly CanonicalSeed[], cases: readonly SimulationCase[]): Promise<SimulationOutcome[]>;
```

Implementation uses a fresh in-memory `bun:sqlite` database with `runMigrations`, real repositories,
the real `IntentMatcherLayer`, `IntentExecutor` and `executeTool`, a fake `TelegramSender` that captures
messages, and a guard that returns `{ success: false, error: 'simulation_blocked' }` for tools with
external effects (`send_invitation`, `resend_invitation`, `notify_participants`, `make_call`,
`schedule_ai_call`, `share_event`, `share_agenda`, and any Google sync). Clock via `setSystemTime` is
not used in production code; the simulator takes `at` and passes it to the executor's time source.
Today neither `IntentExecutor` nor the tool handlers take a clock: executor helpers and handlers such
as `get_upcoming` and the `create_event` past-date gate call `new Date()`/`Date.now()` directly. The
simulator therefore never runs inside the bot process: it runs in a child `bun` process
(`scripts/intent-simulate.ts`, spawned with a bounded timeout by the harness and by PR-2's
`simulate` stage) whose preload module `src/services/intent/simulation/case-clock.ts` replaces the
global clock with one the simulator sets to each case's `at`. No production handler or executor code
changes, and the bot process clock is never touched. The child has no network and opens no file other
than its in-memory database.
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
- Three-way comparison report: historical AI answer (from the corpus record), simulated intent reply,
  and the label's `idealResponse`, scored by the rubric shared with PR-2 (`response-quality.ts`). The
  scoring is written to the private output only.
- Contextual cases: the harness builds `SyntheticReference` from the case's `prior` turns only when
  `contextRecovered=true`; otherwise the case is `missing_context` without simulation.

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
