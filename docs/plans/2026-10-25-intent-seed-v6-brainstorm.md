# Intent seed revision 6: brainstorm record (Astra gpt-6-astra + Fable claude-fable-5-1, panel of 3 rounds + moderator)

Topic: docs/plans/2026-10-25-intent-seed-v6-brief.md. The panel saw aggregates only. Full log stays outside git
(review-cli log 20261025T204336_382362Z-brainstorm.md). Moderator synthesis below, followed by what was done with it.

## Dispositions (ticket #827)

| Panel recommendation | Decision |
|---|---|
| Fix answer quality with recognition | done: response renderer (the AI turn after a rule answer stays, owner tg#25314) |
| Cheapest gains first (day reads, punctuation, weekday names, trailing "в календаре") | done in canonicalization and seed-calendar |
| Zero dangerous false matches per write family as a separate hard gate | done: `unconfirmedWrites`, `harmfulFalseMatch`, per-write-family `wrong` all must be 0 in `test/services/intent/intent-kpi-gate.test.ts` |
| Activation: automated, idempotent, digest-bound, persisted rollback | done as boot-time gated activation (no human in the loop, as the owner demanded): gate file bound to seed fingerprint, engine digest and history checksum; a fingerprint that was ever activated is never re-activated automatically, so a rollback persists across restarts; backup first; one log line |
| "No mutation at startup" | rejected in favour of the owner's order; mitigated by the gate, the session guard (defers while a live workflow uses a replaced rule), idempotence and the one-command rollback |
| Defer invites and create+invite | not deferred: confirmation shows both effects, the executor reports a partial write instead of retrying; per-effect idempotency stays a follow-up |
| Shadow mode for noun-less delete | not deferred: exactly-one-match, ask-first, show-exact-target, abstain on no match |
| 80% only by honest denominator, publish all-traffic coverage | `intentLikeCoverage` (denominator includes calendar requests deliberately left to the AI) is reported next to `coverage` |
| Independent holdout, lineage splits | authors were blind to the rules; held-out authored by separate writers; real-history split pending (owner order tg#25026) |

## Moderator synthesis

# Moderator synthesis: intent seed revision 6

The brief itself was not in this prompt. This synthesis comes from the transcript, where round 3 participants quoted the brief directly: the 12/17/43 miss buckets, 185 intent-like messages, 3 of 119 non-abstaining negatives, the 56% rubric failure rate and the owner's requirement that merging activates production.

## Best ideas (ranked)

1. **Fix answer quality alongside recognition.**
   - 56% of answers fail the rubric.
   - Fix rendering; the AI supplement turn stays by design (owner tg#25314).
   - Otherwise routing gains don't help users.

2. **Ship the cheapest gain first.**
   - The 12 day-read misses fixed by one edit, plus terminal punctuation, weekday aliases and optional "в календаре".
   - Every participant agreed on this.

3. **Resolve the three non-abstaining negatives before broadening anything.**
   - Each one needs an explanation and a minimal-pair test.
   - Until then they are evidence against safely expanding write recognition.

4. **Add a separate hard gate: zero observed dangerous false matches, per write family.**
   - "Dangerous" means wrong target, wrong actor, wrong recipient, duplicate write or false completion claim.
   - 99% aggregate precision can't be shown with 180 held-out conversations; about 299 error-free cases would be needed.
   - So the aggregate stays a reported threshold, and the per-family dangerous count is the blocker.

5. **Automate activation through an idempotent post-deploy command, in this release.**
   - The receipt is bound to seed, engine, schema and corpus digests. A one-byte mismatch makes the command refuse.
   - Activation runs under a lock as one transaction, with a ledger entry.
   - Rollback is a persisted override that survives restarts and redeploys, with a test for: activate → roll back → restart → revision 3 still routing.
   - The database backup is insurance only and is never the rollback path.
   - No mutation at startup.
   - This satisfies merge-activates-production. A manual runbook alone does not.

6. **Freeze scope by supported user goals, not by syntax or easy families.**
   - Hard wording within an in-scope goal stays in the denominator.
   - Always publish all-traffic coverage alongside it.

7. **Build an independent, router-agnostic holdout.**
   - A separate author writes scenarios without seeing the seed.
   - Split by conversation and paraphrase lineage.
   - Use structured labels with acceptable branches, not verbatim transcripts.
   - Keep the adversarial set separate and append-only, and reserve an untouched final set.

8. **Use a constrained, documented grammar with typed outcomes.**
   - Outcomes: `matched`, `needs_clarification`, `ambiguous`, `unsupported`, each with a reason code.
   - The whole message must be consumed. Bare hours stay ambiguous. Never repair recipients, titles or numbers.
   - Cap input length and test backtracking.

9. **Shadow-test write families with mutations suppressed before promoting them.**
   - Agreement with the AI route is diagnostic, not ground truth. Adjudicate disagreements.

10. **Gate compound and invite families on execution readiness, not parsing.**
    - Required first: per-effect idempotency keys, separately recorded outcomes for each effect, and no recreating the event on retry.
    - Explicit email addresses don't need a contact store. Names must never become guessed addresses.

## Tradeoffs and settled disputes

| Dispute | Resolution |
|---|---|
| Score 80% over only three easy families (architect) vs over all in-scope goals | **All in-scope goals.** Narrowing the denominator manufactures success. |
| Reaching 80% | **It isn't reachable with planned families.** Adding every listed miss bucket to today's 18 matches gives about 94/185 (51%). Re-baseline the target or widen the families; don't hide the gap. |
| Manual activation now, automate later | **Automate now.** It is an owner requirement. |
| Human sign-off for first write-family activation (security) vs fully automatic | **Compromise:** reads activate automatically; each new write family needs a recorded approval in the receipt. |
| Contact store before any invites | **No.** Explicit email addresses are fine once durable partial-success handling exists. |
| Five hits per rule budget | **Rejected.** It invites manufactured examples and penalizes rare but useful commands. Retire rules based on observed benefit and risk. |
| Shadow agreement as a gate | **No.** Use it as evidence; adjudicated disagreements on writes are the gate input. |
| Qualify against every provider | **No.** Qualify the deterministic rules once; test only the AI paths that change. |

## Answers to the six questions (condensed)

1. **Coverage:** Do the work in this order: day reads and punctuation, then answer rendering, then explicit creates (17), then constrained time-first creates (43), then noun-less deletes, then invites. Inference, negotiation, vague references and complex recurrence stay with AI. Nine users don't establish a coverage ceiling, and 80% is a corpus hypothesis.
2. **Model history:** Independent authors, lineage splits, frozen clocks and independently derived expected values. Labels cover actor, permissions, initial state, slots, confirmation target, allowed and forbidden effects, and answer facts. Include failure scenarios: timeouts, restarts mid-flow, a stale or foreign "да", and edits between preview and confirmation.
3. **Families:**
   - Reads: execute, and distinguish a failed read from an empty one.
   - Creates: preview and confirm.
   - Deletes: resolve, ask if ambiguous, confirm, and revalidate at execution time.
   - Invites: only with durable per-effect outcomes.
   - Reschedule, bulk and recurrence: deferred.
   - Negated, quoted and interrogative messages never start a write.
4. **Matcher:** Conservative normalization, preserved slot text, typed outcomes, full consumption, bounded runtime. Resolve the three negatives first.
5. **Activation:** Automated post-deploy command as described in idea 5. Pending confirmations are pinned to their original semantics or explicitly expired. Verify that revision 3 still runs before promising rollback.
6. **KPIs:**
   - Measure first-message recognition, necessary clarification and completed workflows separately, so "да" turns don't inflate coverage.
   - Count AI calls and cost per *correct* completion.
   - Report processing latency, confirmation wait and delivery latency separately.
   - Hard blockers: dangerous false matches, false completion claims, and failed reads shown as empty calendars.
   - Track refused unauthorized attempts.

## Recommendation

**Ship revision 6 as a bounded release with these steps:**

1. Fix day reads and punctuation, answer rendering and supplement suppression.
2. Add explicit and constrained time-first creates.
3. Resolve and test the three negatives.
4. Add the per-family zero-dangerous-match gate.
5. Wire the digest-bound, idempotent post-deploy activation command with a persisted rollback override.

**Run noun-less delete in mutation-free shadow mode.** Defer invites and create+invite to revision 7, after per-effect idempotency exists.

**Restate the 80% target honestly.** Either re-baseline it against the roughly 51% achievable with these families, or record it as an explicit stretch goal. Don't narrow the denominator to hit it.

