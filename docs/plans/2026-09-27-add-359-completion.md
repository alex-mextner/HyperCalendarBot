# Finish /add incident GH-359 / PR 372

Scope: the 23 September 2026 incident, deterministic interactive event entry,
content-neutral user fields, explicit voice preferences, verified release.

## Data integrity and privacy
- [x] Reconcile PR, local dirty worktree, current main and production receipt.
- [ ] Reproduce complete scene transitions with the real GramIO engine and SQLite.
- [ ] Fix date-only/time ambiguity, corrections, invalid dates and DST handling.
- [ ] Reject stale/foreign callbacks; preserve exact user text with HTML escaping.
- [ ] Keep group ownership/timezone correct; prevent duplicate confirmation writes.

## Reliability and interaction
- [ ] Fix the recorded Biome failure on the exact integrated tree.
- [ ] Add Back, quick choices, optional-field skip and preview/confirmation.
- [ ] Verify recurrence date/count modes, defaults and draft persistence.
- [ ] Verify voice opt-in evidence and content-refusal handling without disabling safety.
- [ ] Run full tests, lint, typecheck and independent final review.
- [ ] Commit, update existing PR, ship through normal gates and verify runtime revision.
- [ ] Preserve and clean only superseded work belonging to this task.

## Recovery ledger
Initial PR head: 8853895f5d41d5fd7662ed8b9371df36a443128a.
Integrated main: de31c71a053098a1e2b8cf41d330cdbf61837ef4.
CI on prior PR: 5509 tests passed; Biome failed in four files.
Ruling: retain current main's date-aware IANA calculator; no dependency upgrade.
Old dirty worktree is preserved until its unique changes are reconciled.

## Verified implementation evidence
- Original hosted run passed 5509 tests and failed formatting, not application tests.
- Real-engine tests reproduce the incident using GramIO, SQLite and a local Telegram API fixture; no production user records are used.
- Date parsing RED: 13 explicit-time, numeric-date, correction and DST cases; GREEN after fixing the parser.
- Group/quick entry RED: date-only quick-add wrote midnight, group wizard lost ownership; GREEN through the same seeded draft flow.
- End modes, Back, default durations, exact field text and simultaneous confirmations pass real-engine tests.
- Long-message and relative-end-date tests were observed RED then GREEN.
- Seeded-title Back regression was observed RED with its guard removed, then GREEN restored.
- Latest focused gate: 125 tests passed; full pre-edge gate: 5651 passed, lint and typecheck clean.
- Private voice-preference audit confirmed an earlier explicit opt-in; no user setting was changed.

## Review disposition
The first independent review completed through Sonnet after unavailable CLI/provider routes.
Its two claimed blockers concerned structure/readability, not reproduced incorrect behavior.
Ruling: retain eight distinct GramIO step registrations with a shared navigation guard;
getStepFns still exercises each independently, and the real-engine suite exercises their composition.
The recurrence-count predicate is now named; the confirmation cache is explicitly bounded FIFO,
not a cache of abandoned drafts. Formatter and naming suggestions were applied.
A second review receives the entire final diff against main and the new real-engine test file,
rather than only a partial working-tree diff.

## Remaining release gates
- Final full-suite/lint/typecheck pass on the exact integrated tree.
- Final review findings disposition, normal PR ship and verified immutable deployment receipt.
- Synthetic replay against the deployed source and unsigned-webhook rejection check.
- Preserve superseded task worktree material before cleanup; do not touch unrelated worktrees.
