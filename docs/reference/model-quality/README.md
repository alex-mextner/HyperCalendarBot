# Role qualification harness (`scripts/model-quality`)

Measures how well a model preset does one of the three roles of stage B (planner, executor, repair) against the
real system prompt, the real tool catalog and validators, and a sandboxed calendar. It is the evidence side of the
qualification gate in `src/services/ai/model-presets.ts`; it never edits that registry.

## What is measured

| Role | Cases | What a pass means |
|---|---|---|
| executor | 32 synthetic scenarios (`fixtures.ts`) | the agent's main tool loop makes the expected calls with the expected arguments, makes no unrequested or duplicate write, and does not claim an unproven success |
| repair | the same 32 scenarios | after a fixed unsupported draft ("Готово, всё выполнено.") and the exact production retry nudge (`src/services/ai/repair-nudge.ts`), the model does the task with tools |
| planner | 36 light cases (12 tool-group selections, 12 literal extractions, 12 outcome interpretations) | the structured answer equals the label exactly; fenced or truncated JSON fails |

Executor and repair rounds go through the production streaming slot (`streamingSlot`), so the request fields, sampling,
effort control, output ceiling and stream handling are what the bot would send. Candidates come from the preset registry
(`models.ts`). A pass-rate counts every attempt: an HTTP error, a timeout or an empty answer is a failure, never dropped.

## The gate this does not close

`isQualifiedFor` needs two numbers: own-role pass-rate at or above 95%, and 100% on the full labelled history. The history
half has no corpus (#565): the #562 corpus is 667 deterministic parser cases with zero LLM calls. So the report prints
`qualification: null` for every preset, whatever the own-role pass-rate. Qualification is set by a reviewed change to the
registry after a history run exists, never by this tool.

## Running it

Live runs are manual and cost money. Tests never import `run.ts` or `report.ts`.

```bash
bun --env-file=<path to .env> scripts/model-quality/run.ts \
  --out <NEW directory> --models deepseek41-flash@openrouter \
  --roles executor,repair,planner --budget 0.8 [--already-spent <USD of the other invocations of this run>]
bun scripts/model-quality/report.ts --out <NEW directory> <run directory> [<run directory> ...]
```

- The run-wide ceiling is 3 USD (`budget.ts`); `--budget` plus `--already-spent` cannot exceed it. Every request reserves an
  upper bound before it is sent; a call whose usage never arrived keeps its whole reservation. Spend uses the provider's
  reported `usage.cost` when there is one (OpenRouter) and the dated list price otherwise.
- A failed or uncertain call is recorded once and never replayed. A failure that makes the route unusable (401, 402, 403,
  404, 429, budget) stops that candidate.
- Credentials are read from the environment only and are never written to a manifest or a row.

## Evidence layout (append-only)

Each invocation creates one new directory under `logs/benchmark-history/` (gitignored, restricted local logs):

- `manifest.json` written before request 1: source SHA and tree, whether harness/source files were dirty, SHA-256 of the
  prompt, tools, fixtures, repair nudge and planner instructions, tool-schema mode, per-candidate model settings and dated
  price, roles, cases, repeats, budget, scope (`privateHistorySent: false`, `qualification: null`)
- `results.jsonl` one row per attempt, appended as it finishes (synthetic fixtures only: no personal data)
- `SHA256SUMS` written once at the end

Checked-in summaries live next to this file, one dated directory per measurement, with the manifests, the aggregate
`report.json` / `report.ru.md` and the SHA-256 of every raw file. A later run never replaces an earlier one.
