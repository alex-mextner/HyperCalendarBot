# Intent coverage methodology

How HyperCalendar measures which user requests its approved intent rules answer correctly and
safely without the AI agent. Spec: `docs/specs/2026-09-28-intent-recovery-334-coverage.md`.
Code: `src/services/intent/simulation/`, `scripts/intent-coverage.ts`, `scripts/intent-simulate.ts`.

## Two numbers, never merged

- **Matcher-only**: the rule matcher routed the request to exactly one rule. This is regex routing
  and says nothing about whether the answer was right. It reproduces the historical replay count
  (`scripts/replay-intent-corpus.ts`).
- **Covered**: the request, run end to end through the real matcher layer, executor and tool
  handlers, behaved the way an independent label says it should. Only this number is coverage.

## How a case runs

Each case runs in a child `bun` process (`scripts/intent-simulate.ts`), never in the bot:

- a fresh copy of a migrated in-memory SQLite database that holds only the measured rules
  (approved, unmanaged) and the case's synthetic calendar; the production database is never opened;
- the real `IntentMatcher`, `createIntentMatcherLayer`, `IntentExecutor` and `executeTool`;
- a real GramIO `Bot` and `MessageContext` whose Bot API calls are answered locally, so every text
  the bot would send to the requester is captured and nothing leaves the process;
- network (`fetch`) and process spawning (MTProto bridge, voice calls) are sealed before the first case;
- the clock: a preload (`case-clock.ts`) replaces the global `Date` so every "now" read returns the
  case's own recorded time. Handlers and executor code are unchanged; the bot process clock is
  never touched.

Tools whose effect reaches someone else — invitations, participant notifications, sharing, calls,
triggers, secretary changes, feedback to the admin — are answered with `simulation_blocked` and
listed in `blockedExternal`. Local reads (contacts, user lookup without a resolver, Google and
Telegram connection status) run against the database. Image rendering needs a headless browser
and only delivers to the requester; it is stubbed and counted in `stubbedRender`.

When a rule suspends with a yes-like option (Да, Yes, OK, Подтвердить, Confirm), the harness
answers it once. A second suspension, or a suspension without a yes-like option, is a question
to the user. A reply ending in "?" from a run that attempted no write is also a question.

## Buckets

Every case lands in exactly one bucket. Only `covered` counts as success.

| Bucket | Meaning |
| --- | --- |
| `covered` | Label class `direct` or `contextual`; one rule matched; no unsafe effect; the run handled the request without asking back; the reply is non-empty and grounded; tool families equal the label's (read labels), or the label's writes were applied after confirmation (write labels) |
| `correct_clarification` | A `clarification` case where the rule asked a question and wrote nothing |
| `missing_context` | A `contextual` case: prior-turn references are not available to rules yet (reference store, #557), so it is not simulated |
| `ambiguous` | The matcher abstained with `ambiguous` |
| `unsafe` | A blocked external effect, a write without confirmation, or any applied write for a read-only label |
| `wrong_behavior` | Matched, but the tools, write outcome, grounding or class differ from the label (including a matched rule that failed and fell through to the AI agent, and a run that threw; the error is kept in the outcome and the other cases still run) |
| `missing_capture` | The matcher abstained because a required fragment was absent |
| `abstained` | The matcher abstained with `no_match` or `input_too_long`; the AI agent answers |
| `excluded_sensitive` | Sensitive cases (credentials, codes, personal documents); never simulated |
| `unlabelled` | No independent label exists for the case; it is simulated but can never count as covered |

A matcher abstention reason that is not in this table fails the run instead of being guessed. So
does a case whose time zone the runtime does not know: it is refused by case id when the corpus or
fixtures are read.

Label classes `out_of_scope` and `unsupported` have no success bucket: a correct outcome for them
is `abstained` (the AI agent answers), and any matched rule is `wrong_behavior` or `unsafe`. The
per-class table in `summary.json` (`byClass`) reports every class separately.

### Tool families

Read labels compare the set of successful tool families. `get_events`, `get_upcoming`,
`search_events` and `get_event` are one family (`events_read`); the `render_*` tools are one
family (`image`); every other tool is its own family. `ask_user`, `pick_users`,
`end_conversation` and `set_reaction` talk to the requester and are ignored. Write labels compare
the families of the successful writes (`isMutationTool`, the same classification the executor uses
for write evidence); reads around the write do not matter.

### Grounding

Every clock time (`HH:MM`) and numeric date (`YYYY-MM-DD`, two-digit `DD.MM`, `DD.MM.YYYY`; so
"1.5 часа" is not a date) in the reply
must come from the same run: a tool result (UTC instants converted into the case's zone, local
wall-clock values as printed), an event in the calendar after the run, or the case clock. Dates
compare by month and day. Event titles and worded dates ("11 сентября") are not checked.

## Labels and the three answers

Labels are independent of the bot's old answers: class, family, expected tools and an ideal
response. The historical AI answer is carried only for comparison and is never the expected
answer. `three-way.jsonl` puts the historical answer, the simulated reply and the ideal response
side by side; a missing ideal response is reported as `idealMissing`, never replaced. Rubric
scoring (`docs/intents/response-quality.md`) is not automated yet; rows say `rubric: "unscored"`.

Label batches whose run receipt is not `completed` keep their labels with provenance
`unverified`; `summary.json` counts verified, unverified and missing labels.

## Calendars

Fixtures carry their own synthetic calendars. The private corpus runs every case on an empty
calendar: production calendars are never read. A read therefore answers "nothing scheduled" for
the case's date and zone, and a request that needs an existing event (delete by title, move "the
dentist") cannot succeed and lands in `wrong_behavior`. `summary.json` records this as
`calendarPolicy`.

## Running it

Committed synthetic fixtures (`test/fixtures/intent-corpus/synthetic-cases.json`, written from
scratch, `origin: "synthetic"`, at least six cases per class, each with the bucket it lands in
under the source seed):

```sh
bun scripts/intent-coverage.ts --fixtures test/fixtures/intent-corpus/synthetic-cases.json --out logs/coverage-fixtures
```

Private retained corpus, locally only (the corpus and label files stay where they are):

```sh
bun scripts/intent-coverage.ts \
  --corpus logs/intent-learning-20260919/semantic-cases.json \
  --labels logs/intent-learning-20260919 \
  --rules seed [--compare <exported replace_all revision body.json>] \
  --out logs/<private run dir>
```

`--rules` and `--compare` take `seed` (the source catalogue) or an exported `replace_all` revision
body; an `operations` body is refused because it is a change, not a rule set. `--out` must be under
the repository's ignored `logs/` or outside the repository; anything else is refused (exit 2).

Output: `summary.json` (counts, rule fingerprint, bucket totals, per-class table, matcher-only
column, comparison gained/lost case ids), `cases.jsonl` (case id, bucket, intent, tools; no
request text), `three-way.jsonl` (answer texts; private), `comparison.jsonl` (per-case bucket
changes, with `--compare`). A comparison counts gains and losses in `covered` only.

Before committing fixtures, run the privacy check with the private files present:
`INTENT_PRIVATE_CORPUS=<corpus.json>:<cases.json> bun test test/services/intent/simulation/fixture-privacy.test.ts`.
It fails when any fixture string equals or nearly equals (normalized edit distance under 0.3) a
private request; in CI the files are absent and the check is skipped.
