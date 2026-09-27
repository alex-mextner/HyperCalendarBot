# HANDOFF: GH-334 intent recovery

- Task: [GH-334](https://github.com/alex-mextner/HyperCalendarBot/issues/334) - contextual
  intents plus server-orchestrated Opus intent learning with admin approval.
- Branch: `feat/intent-recovery-334-20260927`, based on origin/main
  `7399876eeb572e0c021cb44004931aec80624311` (production ran the same SHA on 2026-09-27).
- Evidence and checkpoint dir (private, gitignored, exists only in the main checkout, not in any
  worktree): `/Users/ultra/xp/hypercalendarbot/logs/intent-resume-20260927-chatgpt-334/` (`checkpoint.json`, `checkpoint.md`).

## Recon (complete, private)

- Preservation of the five 2026-09-19 dirty worktrees with checksums:
  `/Users/ultra/xp/hypercalendarbot/logs/intent-resume-20260927-chatgpt-334/preservation/SUMMARY.md`
- State map (issues, PRs, owners, code map, server-to-Mac pattern, Claude CLI facts):
  `/Users/ultra/xp/hypercalendarbot/logs/intent-resume-20260927-chatgpt-334/state-map/REPORT.md`
- Evidence audit (402-message baseline reproduced at 18/402 matcher-only; label provenance gaps):
  `/Users/ultra/xp/hypercalendarbot/logs/intent-resume-20260927-chatgpt-334/evidence-audit/REPORT.md`
- Independent review of the revision spec (6 findings, all incorporated):
  `/Users/ultra/xp/hypercalendarbot/logs/intent-resume-20260927-chatgpt-334/revision-spec-review.md`
- Orchestrator verification: `/Users/ultra/xp/hypercalendarbot/logs/intent-resume-20260927-chatgpt-334/orchestrator-verification.md`
- Private source handoff (not in git): `/Users/ultra/xp/hypercalendarbot/.worktrees/intent-recovery-334-20260927/logs/intent-recovery-private/HANDOFF-with-source.md`
  (this worktree only), file sha256 `2abac17625f2066d976f5a37a3020b9444318285793f4784b04158d3dca74c7c`
  (measured 2026-09-28). The owner's original source attachment it quotes has sha256
  `89f02121b1949332575dc9fc0df97c0508518d1cebbd9c3a2812081cfeb817e2` (425 lines, 56383 bytes).

## Plan and specs

- Plan: `docs/plans/2026-09-28-intent-recovery-334.md`
- Specs: `docs/specs/2026-09-28-intent-recovery-334-{revisions,context-references,learning-service,mac-worker,coverage}.md`

## Child tasks and PRs (merge order)

The plan's PR table is authoritative for files, dependencies and acceptance; this table only tracks
task and PR state.

| Order | Slice | Task | PR | Depends on |
| --- | --- | --- | --- | --- |
| 1 | Revision ledger (migration 065) | [#555](https://github.com/alex-mextner/HyperCalendarBot/issues/555) | not opened; in progress (uncommitted) in `.worktrees/intent-revision-ledger-334`, branch `feat/intent-revision-ledger-334` | none |
| 2 | Simulator and coverage harness | [#556](https://github.com/alex-mextner/HyperCalendarBot/issues/556) | not opened | #555 (merge order only) |
| 3 | Event reference store (migration 066) | [#557](https://github.com/alex-mextner/HyperCalendarBot/issues/557) | not opened | #555 |
| 4 | Learning service | [#560](https://github.com/alex-mextner/HyperCalendarBot/issues/560) | not opened | #555, #556 |
| 5 | Mac worker | [#561](https://github.com/alex-mextner/HyperCalendarBot/issues/561) | not opened | #560 |
| 6 | Wiring and admin commands | [#558](https://github.com/alex-mextner/HyperCalendarBot/issues/558) | not opened | #555, #560; rebase after #508/#509 |
| 7 | Natural entry intents | [#563](https://github.com/alex-mextner/HyperCalendarBot/issues/563) | not opened | #555, #556; rebase coordination with #548 |
| 8 | Contextual intents | [#559](https://github.com/alex-mextner/HyperCalendarBot/issues/559) | not opened | #555, #556, #557, #509, #498; rebase coordination with #548 |

External dependents (#426 yes, #548 no): see the plan's "PR table and merge order".

Not owned here: `/add`; providers/routing/benchmarks; #509; #508; #493/#495/#498; #426/PR #394;
#548; #338/PR #337 (separate session, worktree `friendly-agenda-338-20260928`); #554 (shared dialogue
spec, reuses our contextual-reference design).

## Outstanding acceptance

All six GH-334 acceptance criteria remain open. Nothing is merged, deployed or activated. #555 has
RED tests and uncommitted implementation work in `.worktrees/intent-revision-ledger-334` (RED run
recorded privately in `/Users/ultra/xp/hypercalendarbot/logs/intent-resume-20260927-chatgpt-334/ledger-red.txt`).

## Open owner questions

See "Open questions for the owner" in the plan (sample scope, sequencing with #426, reading of
three-way verification).

## Next action

Continue #555 in the existing `.worktrees/intent-revision-ledger-334` (do not create a second
worktree for it): finish the PR-1 tasks in the plan from "RED: migration tests" onward, then review,
commit and ship.
