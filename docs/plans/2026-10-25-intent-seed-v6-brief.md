# Intent seed revision 6: brainstorm brief (ticket #827)

Owner order (2026-10-25): finish seed revision 6, roll it out, activate it. Target: 80% coverage proven by tests
on a purpose-built model history, KPIs measured by benchmarks, engine improved where needed, the merge to main
activates it on production. This brief contains aggregates only; no user text.

## State of the engine (main 06a32c61)

- `src/services/intent/`: matcher (`intent-matcher.ts`), 52 canonical rules in `seed-*.ts` (13 categories), typed
  bindings (`workflow-bindings.ts`), executor, revision ledger. Rules are one JS regex per rule matched against the
  WHOLE message (strict structure, trailing `?!` stripped), plus an exact-phrase index. Two matching rules are
  `ambiguous` and abstain. Writes always go through a yes/cancel question. A bare hour 1-12 without am/pm/part of
  day is rejected by the `time` binding (never guessed), so the message falls to the AI.
- Production: 52 approved rules, active revision 3 (2026-09-28). Revision approval has no entry point (#558).
- Traffic (since 2026-09-19, 9 users): 195 text messages, 10 answered by a rule (5.1%), 0 in the last 26 days. Replay
  of 303 retained texts: 18 match (5.9%). 185 of 303 are intent-like; 167 of those do not match. Census of the
  misses: verb-less or time-first create 43, create plus invite compound 34, delete without the word "event" 18,
  explicit-verb create 17, day-read variants 16 (12 fixed by one edit), invite-only 13, remaining ~26 (weekday names,
  "в календаре" suffix, "когда/где", trailing dot).
- Routing accuracy on synthetic probes: 244/244 declared examples, 99.87% case/punctuation variants, 78% hand-written
  paraphrases (weak: calendar.upcoming 1/8, holidays.upcoming 0/6, bot.info 0/3, calendar.image 2/6), 29% with a
  trailing `.` `,` `...`, 4.7% typos. Negatives: 116/119 abstain, no overlaps among the 52 patterns.
- Execution: 98.18% over 20,896 runs (6 zones incl. DST, after-midnight, personal/group, ru/en); 0 DB writes before
  confirmation; but 56% of answers break `docs/intents/response-quality.md` (raw ISO dates, confirmation never says
  "done", raw JSON, English in ru chats, Cyrillic title search case-sensitive) and nearly every read answer is
  followed by a full AI supplement turn.
- Existing corpora: none labelled for the rule engine. 667 unified-dialogue parser cases (design contracts, branch
  docs/dialogue-spec-20260928), 32 anonymised tool-contract scenarios (PR #429), a private NLU candidate corpus
  (weak regex labels, not gold), the audit's 7,460 synthetic probes. #565 (labelled replay corpus) is not built.

## Plan being considered

1. Build a synthetic "model history" (>=600 conversations; ru primary, en; private/group; calendar state; frozen
   clock + IANA zone; follow-up turns such as "да") labelled by family, slots and expected tool calls, or "the AI
   fallback is the correct answer". Dev split used while writing rules; held-out split (>=30%) authored
   independently of the seed and measured only at checkpoints.
2. Benchmark (`scripts/benchmark-intents.ts`): coverage = correct rule handling / in-scope messages; precision =
   correct among handled (false matches on AI-correct messages count); rubric pass rate; TZ/DST execution; AI
   supplement avoided; p50/p95 latency; per-family tables; append-only JSON result files. CI test fails under
   coverage 80%, precision 99%, rubric 95%.
3. Engine: normalizer (trailing punctuation, typos, ё, spacing), paraphrase tolerance, a deterministic slot parser for
   free-form create (date words, weekdays, "через N", times in any position, durations, invitees) as a typed binding,
   create+invite compounds, delete without the noun, rubric fixes in response rendering, skip the AI supplement when
   the rule answer is complete.
4. Seed revision 6 = revision 5 content (#607/#618 fixes) + new families until the held-out bar is met.
5. Activation: gated auto-activation at bot start (KPI gate file committed in the repo, DB backup first, ledger
   row, idempotent, one-command rollback to revision 3), because the owner wants the merge to activate it.

## Questions for the panel

1. Coverage strategy: which message families dominate real calendar-bot traffic that a deterministic rule can
   handle safely? Which should deliberately stay with the AI? What is the realistic ceiling of rule coverage on
   free-form Russian calendar requests, and is 80% of "in-scope" messages honest or a definitional trick? How
   should in-scope be defined so the number is not gamed?
2. Model-history design: how to make a synthetic history representative (phrasing styles, typos, Cyrillic case,
   relative dates, time zones, group chats, multi-intent messages, follow-up turns) and the held-out split
   genuinely independent of the rule author? Which labels are necessary (route, slots, tool calls, key facts,
   confirmation expectations)? How to avoid circular oracles?
3. Intent families to add (list them with the exact safe behaviour: confirm, ask, refuse) and the families where
   false matches are most dangerous (delete, reschedule, invite, bulk, negation, quotation, questions about
   events vs commands).
4. False-match risks of loosening the matcher (paraphrase/typo tolerance, free-form slot parsing, bare hours).
   What guards keep precision at 99%?
5. Gated auto-activation at deploy: what can go wrong (live suspended workflows, restarts, rollback, repeated
   activation after a rollback, DB backup, multi-instance)? Is auto-activation on start safe enough, or should it
   be a post-deploy admin command?
6. KPI design: anything missing or gameable in coverage/precision/rubric/execution/AI-avoided/latency?

Answer concretely and briefly. Rank recommendations. Name the cheapest changes with the largest coverage gain first.
