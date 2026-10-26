# Intent seed 6: checkpoint (ticket #827), 2026-10-25

Worktree `.worktrees/intent-seed-v6` (branch `intent-seed-v6`, base origin/main 06a32c61 plus the two cherry-picked commits of #767). Nothing is committed, pushed or deployed.

## Measured on the synthetic model history (755 conversations: dev 508, held-out 247 = 33%)

| | revision 3, old engine (prod) | revision 5, old engine | seed 6 (this tree) |
|---|---|---|---|
| held-out coverage | 10.8% | 10.8% | 80.5% |
| held-out precision | 71.4% | 71.4% | 100% |
| held-out rubric pass | 45.0% | 45.0% | 100% |
| dev coverage / precision | 18.7% / 83.8% | 18.7% / 83.8% | 94.4% / 100% |
| TZ/DST matrix (3192 cells) execution | 79.2% | 79.2% | 100% (precision 98.1%: two weekday-equals-today messages still matched in some cells) |
| AI turn avoided after a correct answer | 19.5% | 19.5% | 99.0% |
| unconfirmed writes / exceptions / harmful false matches | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |

Baselines: `docs/intents/benchmarks/2026*baseline-*.json` (old engine on main 06a32c61). Seed 6 numbers come from `bun --no-env-file scripts/benchmark-intents.ts --matrix 10`.
The held-out coverage is 0.5 points over the bar on 247 messages: it is not statistically solid.

## Done in the tree

- Model history, benchmark, oracle, rubric, matrix, append-only results: `scripts/intent-benchmark/`, `scripts/benchmark-intents.ts`, `docs/intents/model-history/`.
- Engine: canonical input (ё, punctuation, courtesy words, typo repair with repaired captures), `event_phrase` and stemmed `eventref` bindings, weekday/"через N дней" dates, `abstain` and `plan_move` steps, natural yes/no, human day/time/duration filters, answer renderer and `completeResponse`.
- Seed: 54 rules (create/create+invite merged into free-form rules, delete/reschedule/reminders/invites rewritten, reads extended, `calendar.when`, `calendar.next` added).
- Activation path (separate agent): `kpi-gate.ts`, `seed-activation.ts`, `db-backup.ts`, `scripts/intent-revision.ts`, boot wiring in `src/bot/index.ts`, Dockerfile, engine.md section.
- Tests added/updated: model-history, intent-kpi-gate (red until `docs/intents/kpi-gate.json` exists), event-phrase, kpi-gate, seed-activation, intent-revision, response-formatter, executor, layer, bindings, move-plan, human-duration, seed-catalog.

## NOT done (exact list)

1. Owner order tg#25026: the evaluation set must be built from REAL history with pseudonymisation (mapping private, scrubber run on the odroid, leak gates, labels from historical outcomes, held-out >= 30% of the real set, KPI primarily on it, synthetic as an additional split). Nothing of that exists yet. Plan: (a) scrubber `scripts/scrub-intent-corpus.py` run on root@odroidn2 against `/opt/hypercal/data/calendar.db` chat_history/user_action_log and `private-audit/*`, entity lists from users/contacts/places/groups/participants, deterministic gender- and declension-aware name pools, stable mapping stored 0600 outside git; (b) label derivation from the historical tool calls/answers plus rule ground truth; (c) leak gates in `test/services/intent/real-history-leaks.test.ts` (entity strings with stems, phone/email/URL/@handle/long ids) and a review-panel audit of scrubbed samples; (d) `conversations.real-dev/real-heldout.jsonl` + manifest without mapping; (e) run the same benchmark and report n and a confidence interval. At 195 retained user texts from 9 users the real set is small: 80% cannot be proven statistically on it, say so with the interval.
2. `docs/intents/kpi-gate.json` is NOT written, so nothing activates on prod. Reason: the gate should be produced from the real-derived held-out result (point 1). To produce it from the synthetic result only: `bun --no-env-file scripts/benchmark-intents.ts --matrix 10 --gate`.
3. Seed docs regeneration (`bun run docs:intents`, `docs:intents:check`), lineage rows for removed `basis.event.create_range`, README/CLAUDE.md KPI paragraphs, migration/ledger numbering check, #819 rebase.
4. Whole-repo typecheck (oracle.ts and others use a few inline casts to clean), knip, full test suite on the laptop; known failing before this change: test/regressions/invite-status-roster.test.ts (Quality agent saw one failure, cause unconfirmed).
5. Review gate (`review diff --staged --task 827`), commits, PR, `gh ship`, deploy verification, activation proof, rollback dry-run, tg reports.
